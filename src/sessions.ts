import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { HOME, STATE_DIR, isBlocked, loadConfig, styleFor, type Config } from "./config.ts";
import { runningAgents, type RunningAgent } from "./agents.ts";
import { askFromQuestion, askFromScreen, askFromText, captureScreen, type Ask } from "./asks.ts";

/**
 * Every live Claude Code session on this machine, read from the registry Claude Code keeps in
 * <config dir>/sessions/<pid>.json (the same one cross-session messaging uses), plus each session's
 * transcript for context size and the last thing said. Nothing here needs hooks or a server.
 */

export type State = "working" | "needs-you" | "idle" | "stale";

export interface Session {
  name: string;
  /** Agents it has running now (foreground, or background until their finish notice). */
  agents: RunningAgent[];
  /** What the map shows: the name, or for an automatic one ("myrepo-abc-12-93") something shorter ("ABC-12"). */
  display: string;
  sessionId: string;
  pid: number;
  profile: string;
  kind: string; // interactive | bg
  cwd: string;
  repo: string; // repo root (worktrees map to their main repo), or cwd when not in git
  state: State;
  waitingFor?: string;
  tmux?: string;
  model?: string;
  contextTokens: number;
  contextPct: number;
  needsHandoff: boolean;
  /** The handoff note it wrote after its last prompt (then needsHandoff is off). */
  handoffNote?: string;
  lastActivity: number;
  lastPrompt?: string;
  lastReply?: string;
  /** One line: what it's doing now (latest tool or text) while working, else the start of its last reply. */
  doing?: string;
  /** When its last reply (assistant text) was written, for the map's unread dot. */
  lastReplyAt?: number;
  domain: string;
  icon: string;
  color: string;
  /** Waiting on Vedran (permission dialog, or its last message asks something), with likely answers. */
  ask?: Ask;
  /** Quick replies are off here (blocked/client folder): the popup only offers "open it yourself". */
  askBlocked?: boolean;
  spawnedBy?: { group: string; at: number };
  transcript: string;
}

function configDirs(): { profile: string; dir: string }[] {
  const dirs = [{ profile: "claude", dir: path.join(HOME, ".claude") }];
  for (const entry of readdirSync(HOME)) {
    if (entry.startsWith(".claude-") && existsSync(path.join(HOME, entry, "sessions"))) {
      dirs.push({ profile: entry.slice(".claude-".length), dir: path.join(HOME, entry) });
    }
  }
  return dirs;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code === "EPERM";
  }
}

const repoCache = new Map<string, string>();
function repoRoot(cwd: string): string {
  if (repoCache.has(cwd)) return repoCache.get(cwd)!;
  let root = cwd;
  for (let dir = cwd; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const git = path.join(dir, ".git");
    if (!existsSync(git)) continue;
    root = dir;
    if (statSync(git).isFile()) {
      // A worktree: ".git" is a file pointing at <main repo>/.git/worktrees/<name>.
      const match = readFileSync(git, "utf8").match(/gitdir:\s*(.+?)\/\.git\/worktrees\//);
      if (match) root = match[1];
    }
    break;
  }
  if (root === HOME) root = cwd;
  repoCache.set(cwd, root);
  return root;
}

export function readTail(file: string, bytes: number): string {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return;
  const parts = content.filter((c: any) => c?.type === "text").map((c: any) => c.text);
  return parts.length ? parts.join(" ") : undefined;
};
const clip = (s: string | undefined, n = 160) => (s ? s.replace(/\s+/g, " ").trim().slice(0, n) : undefined);

// The map polls every couple of seconds; only re-read transcripts that changed.
const transcriptCache = new Map<string, { key: string; value: ReturnType<typeof parseTranscript> }>();
function readTranscript(file: string) {
  if (!existsSync(file)) return parseTranscript(file);
  const st = statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = transcriptCache.get(file);
  if (hit?.key === key) return hit.value;
  const value = parseTranscript(file);
  transcriptCache.set(file, { key, value });
  return value;
}

/** The AskUserQuestion input still waiting for an answer in this transcript (its picker should be on screen), if any. */
export const openQuestion = (file: string): any => readTranscript(file).question;

const HANDOFF_FILE =/\/_?handoffs\/[^/]+\.md$/;

function parseTranscript(file: string) {
  const out: { model?: string; contextTokens: number; lastPrompt?: string; lastReply?: string; doing?: string; lastReplyAt?: number; finalText?: string; mtime: number; question?: any; handoffNote?: string } = { contextTokens: 0, mtime: 0 };
  // AskUserQuestion still open: its tool_use is in the latest reply and no tool_result answered it yet.
  const answered = new Set<string>();
  let ended = false; // the newest entry that is a user or assistant message has been seen
  if (!existsSync(file)) return out;
  out.mtime = statSync(file).mtimeMs;
  const lines = readTail(file, 768 * 1024).split("\n");
  let haveContext = false;
  for (let i = lines.length - 1; i >= 0 && (!haveContext || !out.model || !out.lastPrompt || !out.lastReply || !out.doing); i--) {
    if (!lines[i]) continue;
    let entry: any;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    const message = entry.message;
    // A /compact (or auto-compact) after the last reply: the context is now its post-compact size.
    if (entry.type === "system" && entry.subtype === "compact_boundary" && !haveContext) {
      out.contextTokens = entry.compactMetadata?.postTokens ?? 0;
      haveContext = true;
    }
    if (entry.type === "assistant" && message?.usage) {
      if (!haveContext) {
        const u = message.usage;
        out.contextTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        haveContext = true;
      }
      out.model ??= message.model;
    }
    // The session's final word (for "is it asking me something?"): only if nothing came after it.
    if (!ended && (entry.type === "user" || entry.type === "assistant") && !entry.isMeta) {
      ended = true;
      if (entry.type === "assistant") out.finalText = textOf(message?.content);
    }
    if (entry.type === "user" && Array.isArray(message?.content)) for (const b of message.content) if (b?.type === "tool_result") answered.add(b.tool_use_id);
    if (entry.type === "assistant" && Array.isArray(message?.content)) {
      const blocks = message.content.filter((b: any) => b.type === "text" || b.type === "tool_use");
      const latest = blocks.at(-1);
      if (!out.doing) {
        const q = blocks.find((b: any) => b.type === "tool_use" && b.name === "AskUserQuestion" && !answered.has(b.id));
        if (q) out.question = q.input;
      }
      // A handoff note it wrote since the last prompt: the map stops asking to hand it off.
      for (const b of blocks) if (b.type === "tool_use" && b.name === "Write" && HANDOFF_FILE.test(b.input?.file_path ?? "")) out.handoffNote ??= b.input.file_path;
      if (latest && !out.doing) out.doing = latest.type === "tool_use" ? describeTool(latest) : firstLine(latest.text);
      const text = textOf(message.content);
      if (text && !out.lastReply) {
        out.lastReply = clip(text);
        out.lastReplyAt = Date.parse(entry.timestamp) || undefined;
      }
    }
    if (entry.type === "user" && !out.lastPrompt && !entry.isMeta) {
      const text = textOf(message?.content);
      if (text && !text.startsWith("<")) out.lastPrompt = clip(text);
    }
  }
  return out;
}

/**
 * Automatic names are "<folder>-<n>" or the folder itself; show the ticket in the folder ("myrepo-ABC-12" → "ABC-12")
 * or the folder. A name someone gave (`claude -n`, /rename) stays as it is.
 */
export function displayName(name: string, cwd: string, named: boolean): string {
  const folder = path.basename(cwd);
  // Claude Code/Pocket's own: the folder lowercased, maybe "-<n>". "Beta" in folder "beta" was typed by someone.
  const auto = !named || name === folder || (name === name.toLowerCase() && name.replace(/-[0-9a-f]{1,6}$/, "") === folder.toLowerCase());
  if (!auto) return name;
  return folder.match(/(?:^|[-_])([A-Za-z]{2,10}-\d{1,6})$/)?.[1].toUpperCase() ?? folder;
}

const firstLine = (t: string) => clip(t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*#`>_]/g, "").split("\n").find((l) => l.trim()) ?? "", 120);
const base = (p: unknown) => String(p ?? "").split("/").pop();

/** "Bash: npm test", "Editing sessions.ts", "Messaging PZ"… one short line per tool call. */
function describeTool(block: any): string {
  const i = block.input ?? {}, name: string = block.name ?? "tool";
  if (name === "Bash") return clip(`$ ${String(i.command ?? "").split("\n")[0]}`, 120)!;
  if (name === "Edit" || name === "MultiEdit") return `Editing ${base(i.file_path)}`;
  if (name === "Write") return `Writing ${base(i.file_path)}`;
  if (name === "Read") return `Reading ${base(i.file_path)}`;
  if (name === "Grep" || name === "Glob") return clip(`Searching ${i.pattern ?? ""}`, 120)!;
  if (name === "WebSearch") return clip(`Searching the web: ${i.query ?? ""}`, 120)!;
  if (name === "WebFetch") return `Reading ${String(i.url ?? "").replace(/^https?:\/\/([^/]+).*/, "$1")}`;
  if (name === "SendMessage") return `Messaging ${i.to ?? ""}`;
  if (name === "Agent" || name === "Task") return clip(`Agent: ${i.description ?? ""}`, 120)!;
  if (name.startsWith("mcp__")) return name.split("__").slice(1).join(" ").replace(/_/g, " ");
  return name;
}

function spawnLog(): Map<string, { group: string; at: number }> {
  const map = new Map<string, { group: string; at: number }>();
  try {
    for (const line of readFileSync(path.join(STATE_DIR, "spawned.jsonl"), "utf8").split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line);
      map.set(entry.name, { group: entry.group, at: entry.at });
    }
  } catch {}
  return map;
}

export function listSessions(config: Config = loadConfig()): Session[] {
  const spawned = spawnLog();
  const sessions: Session[] = [];
  // One session can sit in the registry twice (two pids or config dirs after /clear, a resume or a moved cwd):
  // keep the entry updated last, so the map shows one row per sessionId.
  const newest = new Map<string, { at: number; index: number }>();
  const now = Date.now();
  for (const { profile, dir } of configDirs()) {
    const registry = path.join(dir, "sessions");
    if (!existsSync(registry)) continue;
    for (const file of readdirSync(registry)) {
      if (!file.endsWith(".json")) continue;
      let info: any;
      try {
        info = JSON.parse(readFileSync(path.join(registry, file), "utf8"));
      } catch {
        continue;
      }
      if (!info.pid || !alive(info.pid) || !info.cwd) continue;
      const slug = info.cwd.replace(/[^a-zA-Z0-9]/g, "-");
      const transcript = path.join(dir, "projects", slug, `${info.sessionId}.jsonl`);
      const t = readTranscript(transcript);
      const lastActivity = Math.max(info.statusUpdatedAt ?? 0, info.updatedAt ?? 0, t.mtime);
      let state: State = info.status === "busy" ? "working" : info.status === "waiting" || info.waitingFor ? "needs-you" : "idle";
      if (state === "idle" && now - lastActivity > config.staleHours * 3_600_000) state = "stale";
      const name = info.name ?? path.basename(info.cwd);
      const style = styleFor(name, info.cwd, config);
      const isDisp = info.cwd === path.join(STATE_DIR, "dispatcher");
      // Permission dialog on screen beats text; only for sessions waiting/idle, never the dispatcher itself.
      let ask: Ask | undefined;
      if (!isDisp && (state === "needs-you" || state === "idle" || t.question)) {
        if (t.question) ask = askFromQuestion(t.question);
        if (!ask && state === "needs-you" && info.tmux) ask = askFromScreen(captureScreen(info.tmux));
        ask ??= askFromText(t.finalText);
      }
      // An unanswered AskUserQuestion means its picker is waiting on Vedran, whatever the registry says.
      if (!isDisp && t.question && (state === "idle" || state === "stale")) state = "needs-you";
      const updatedAt = Math.max(info.updatedAt ?? 0, info.statusUpdatedAt ?? 0);
      const seen = newest.get(info.sessionId);
      if (seen && seen.at >= updatedAt) continue;
      newest.set(info.sessionId, { at: updatedAt, index: seen?.index ?? sessions.length });
      sessions[seen?.index ?? sessions.length] = {
        name,
        display: displayName(name, info.cwd, !!info.name),
        agents: runningAgents(transcript),
        sessionId: info.sessionId,
        pid: info.pid,
        profile,
        kind: info.kind ?? "interactive",
        cwd: info.cwd,
        repo: repoRoot(info.cwd),
        state,
        waitingFor: info.waitingFor,
        tmux: info.tmux,
        model: t.model,
        contextTokens: t.contextTokens,
        contextPct: Math.round((t.contextTokens / config.contextWindow) * 100),
        needsHandoff: t.contextTokens >= config.handoffTokens && !t.handoffNote,
        handoffNote: t.handoffNote,
        lastActivity,
        lastPrompt: t.lastPrompt,
        lastReply: t.lastReply,
        doing: t.doing,
        lastReplyAt: t.lastReplyAt,
        ...style,
        ask,
        askBlocked: !!isBlocked(info.cwd, config),
        spawnedBy: spawned.get(name),
        transcript,
      };
    }
  }
  return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
}
