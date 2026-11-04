import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME, STATE_DIR, expand, isBlocked, loadConfig, type Config } from "./config.ts";
import { listSessions, readTail, type Session } from "./sessions.ts";

/**
 * The dispatcher is an ordinary interactive Claude session named "Switchboard", running in tmux so the
 * map can type into it (via Pocket's API when Pocket runs, else our own tmux server). Its transcript
 * is the source for the chat panel and for the "request flies to a bubble" animations.
 */

export const DISPATCHER_DIR = path.join(STATE_DIR, "dispatcher");
const REPO = path.join(import.meta.dirname, "..");
import { OWN_TMUX, socketFor } from "./tmux.ts";
const OWN_SESSION = "switchboard";

export function prepareDispatcherDir() {
  mkdirSync(path.join(DISPATCHER_DIR, ".claude"), { recursive: true });
  mkdirSync(path.join(STATE_DIR, "handoffs"), { recursive: true });
  const links: [string, string][] = [
    [path.join(REPO, "dispatcher", "CLAUDE.md"), path.join(DISPATCHER_DIR, "CLAUDE.md")],
    [path.join(REPO, "dispatcher", "settings.json"), path.join(DISPATCHER_DIR, ".claude", "settings.json")],
  ];
  for (const [from, to] of links) if (!existsSync(to)) symlinkSync(from, to);
}

export const isDispatcher = (s: Session) => s.cwd === DISPATCHER_DIR;

/**
 * One chat line. session: the session it concerns (notice from it, route to it, "→ Name: …" reply), so
 * the map can tint it with that session's colour. tool: a compact tool-activity row (icon, label, detail).
 */
export interface ChatLine {
  id: string; at: number; role: "you" | "switchboard" | "notice" | "tool" | "ask" | "shell"; text: string;
  /** role "shell": something you typed that isn't a message: a `!` shell command or a /slash command, and what it printed. */
  output?: string;
  session?: string; tool?: { name: string; icon: string; label: string; detail: string };
  /** role "ask" (AskUserQuestion): the questions, and the answers once given. */
  questions?: { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[];
  answers?: Record<string, string>;
  /** role "you": typed while it was busy and taken in mid-turn (recorded as a queued_command attachment). */
  queued?: boolean;
}
export interface Route { id: string; at: number; kind: "send" | "spawn"; target: string; text: string }

function pocketKey(config: Config) {
  try {
    return readFileSync(path.join(expand(config.pocketStateDir), "access-key"), "utf8").trim();
  } catch {
    return "";
  }
}

async function pocket(config: Config, route: string, body?: unknown): Promise<any> {
  const res = await fetch(`${config.pocketUrl}${route}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", cookie: `pocket_key=${pocketKey(config)}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pocket refused it (${data.error ?? `HTTP ${res.status}`})`);
  return data;
}

async function pocketUp(config: Config) {
  if (config.backend === "bg" || !pocketKey(config)) return false;
  return pocket(config, "/api/launch-options").then(() => true, () => false);
}

// stderr ignored: "no server running" is an expected answer here, not something to print.
const QUIET = { encoding: "utf8" as const, stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[] };
const ownTmux = (args: string[]) => execFileSync("tmux", [...OWN_TMUX, ...args], QUIET);
const ownTmuxAlive = () => {
  try {
    ownTmux(["has-session", "-t", `=${OWN_SESSION}`]);
    return true;
  } catch {
    return false;
  }
};

const POCKET_NAME_FILE = path.join(STATE_DIR, "dispatcher.tmux");
const pocketTmux = (args: string[]) => execFileSync("tmux", ["-L", "pocket", ...args], QUIET);

/** Where to type: the dispatcher's tmux session name, and whether it lives in Pocket's tmux. */
function tmuxTarget(s: Session | undefined): { name: string; pocket: boolean } | undefined {
  if (s?.tmux) return { name: s.tmux.split(":")[0], pocket: s.tmux.startsWith("pk-") };
  // Started but not registered yet: usually sitting at the first-run "trust this folder" prompt.
  try {
    const name = readFileSync(POCKET_NAME_FILE, "utf8").trim();
    pocketTmux(["has-session", "-t", `=${name}`]);
    return { name, pocket: true };
  } catch {}
  if (ownTmuxAlive()) return { name: OWN_SESSION, pocket: false };
}

function screen(target: { name: string; pocket: boolean }): string {
  try {
    return execFileSync("tmux", [...(target.pocket ? ["-L", "pocket"] : OWN_TMUX), "capture-pane", "-p", "-t", `=${target.name}:`], QUIET);
  } catch {
    return "";
  }
}

/** Vedran pressed "Trust it" on the map: pick "Yes, I trust this folder" (the second option). */
export function acceptTrust(config: Config = loadConfig()) {
  const target = tmuxTarget(listSessions(config).find(isDispatcher));
  if (!target || !/trust this folder/i.test(screen(target))) throw new Error("No trust prompt showing");
  execFileSync("tmux", [...(target.pocket ? ["-L", "pocket"] : OWN_TMUX), "send-keys", "-t", `=${target.name}:`, "Down", "Enter"]);
}

export async function startDispatcher(config: Config = loadConfig()): Promise<string> {
  prepareDispatcherDir();
  if (tmuxTarget(listSessions(config).find(isDispatcher))) return "already running";
  if (await pocketUp(config)) {
    const { name } = await pocket(config, "/api/sessions", { cwd: DISPATCHER_DIR, profile: "claude", name: "Switchboard" });
    writeFileSync(POCKET_NAME_FILE, name);
    return `started in Pocket (${name})`;
  }
  const shell = process.env.SHELL || "/bin/zsh";
  ownTmux(["new-session", "-d", "-s", OWN_SESSION, "-c", DISPATCHER_DIR, "-x", "120", "-y", "40", shell, "-lic", `exec command claude -n Switchboard --add-dir ${JSON.stringify(expand(config.uploadsDir))}`]);
  return "started (tmux -L switchboard attach -t switchboard)";
}

/** Types a message into the dispatcher as if Vedran typed it (typed, not pasted, so it counts as his). */
/**
 * Pocket's API only takes lowercase session names (`^(pk|ro)-[a-z0-9._-]+$`), but it names sessions after their folder,
 * so a folder like "repo-ABC-12" gives "pk-claude-repo-ABC-12", which its own API rejects ("bad session"). Those are
 * typed straight into Pocket's tmux instead, which works the same.
 */
export const POCKET_NAME = /^(pk|ro)-[a-z0-9._-]+$/;
/** The target isn't there any more: retrying can't help. The map shows it without a Retry button. */
export class GoneError extends Error { gone = true; }

async function typeInto(target: { name: string; pocket: boolean }, text: string, config: Config) {
  if (target.pocket && POCKET_NAME.test(target.name) && (await pocketUp(config))) {
    await pocket(config, `/api/sessions/${encodeURIComponent(target.name)}/send`, { text, submit: true, id: `sb-${Date.now()}` });
    return;
  }
  const socket = target.pocket ? ["-L", "pocket"] : OWN_TMUX;
  const flat = text.replace(/[\x00-\x1f\x7f]+/g, " ");
  for (let at = 0; at < flat.length; at += 200) {
    // `--`: a piece starting with "-" is text, not a send-keys flag.
    execFileSync("tmux", [...socket, "send-keys", "-t", `=${target.name}:`, "-l", "--", flat.slice(at, at + 200)]);
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 300));
  execFileSync("tmux", [...socket, "send-keys", "-t", `=${target.name}:`, "Enter"]);
}

/** Types a message into the dispatcher as if Vedran typed it (typed, not pasted, so it counts as his). */
export async function say(text: string, config: Config = loadConfig()): Promise<void> {
  text = text.trim();
  if (!text) throw new Error("Say something first");
  const target = tmuxTarget(listSessions(config).find(isDispatcher));
  if (!target) throw new Error("The dispatcher isn't running. Start it first.");
  await typeInto(target, text, config);
}

/** Talking to one session directly (the bubble popup). Only sessions living in tmux can be typed into. */
export async function sayTo(sessionId: string, text: string, config: Config = loadConfig(), { quick = false } = {}): Promise<void> {
  text = text.trim();
  if (!text) throw new Error("Say something first");
  const s = listSessions(config).find((x) => x.sessionId === sessionId);
  if (!s) throw new GoneError("That session isn't running any more");
  if (isDispatcher(s)) throw new Error("Talk to Switchboard in the main chat");
  if (quick && isBlocked(s.cwd, config)) throw new Error("Quick replies are off for this folder (blocked). Answer it in its own terminal.");
  if (!s.tmux) throw new Error(`${s.name} doesn't run in tmux, so it can't be typed into from here. Open it in a terminal.`);
  await typeInto({ name: s.tmux.split(":")[0], pocket: s.tmux.startsWith("pk-") }, text, config);
}

/**
 * `sb send NAME TEXT`: type a message into a session by name, for sessions SendMessage can't reach
 * (other profiles, e.g. game). Guarded: the profile must be in sendProfiles, the folder not blocked,
 * and the session must run in tmux.
 */
export async function sendByName(name: string, text: string, config: Config = loadConfig()): Promise<string> {
  text = text.trim();
  if (!text) throw new Error("usage: sb send NAME TEXT");
  const matches = listSessions(config).filter((s) => s.name.toLowerCase() === name.trim().toLowerCase() && !isDispatcher(s));
  if (!matches.length) throw new Error(`No live session called "${name}". Run sb ls for the names.`);
  if (matches.length > 1) throw new Error(`${matches.length} sessions are called "${name}". Rename one first.`);
  const s = matches[0];
  if (!config.sendProfiles.includes(s.profile)) throw new Error(`NOT ALLOWED: profile "${s.profile}" isn't in sendProfiles (~/.switchboard/config.json).`);
  const blocked = isBlocked(s.cwd, config);
  if (blocked) throw new Error(`BLOCKED: ${s.cwd} matches "${blocked}". Vedran talks to that session himself.`);
  if (!s.tmux) throw new Error(`${s.name} doesn't run in tmux, so it can't be typed into. Tell Vedran to use it directly.`);
  await typeInto({ name: s.tmux.split(":")[0], pocket: s.tmux.startsWith("pk-") }, text, config);
  return `sent to ${s.name} (${s.profile})`;
}

/**
 * Keys the map can press in a session's terminal (quick replies to a dialog, the sheet's quick keys bar): the page's
 * name → tmux's key name. Single characters are typed literally (`send-keys -l`). A Map, so "constructor" isn't a key.
 */
export const KEYS = new Map<string, string>([
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "y", "n"].map((k): [string, string] => [k, k]),
  ["esc", "Escape"], ["enter", "Enter"], ["up", "Up"], ["down", "Down"], ["left", "Left"], ["right", "Right"], ["space", "Space"],
  ["tab", "Tab"], ["stab", "BTab"], ["ctrlc", "C-c"],
]);
/** What Pocket's /key API takes (its KEYS, same names); anything else goes straight to tmux. */
const POCKET_KEYS = new Set(["1", "2", "3", "4", "5", "y", "n", "esc", "enter", "up", "down", "tab", "stab", "ctrlc"]);
/** The `tmux send-keys` arguments for one of KEYS (throws for anything else). */
export function tmuxKeyArgs(key: string): string[] {
  const k = KEYS.get(key);
  if (!k) throw new Error("unknown key");
  return k.length === 1 ? ["-l", k] : [k];
}

/** Press one key in the session's terminal (only on Vedran's click in the map). */
export async function pressKey(sessionId: string, key: string, config: Config = loadConfig()): Promise<void> {
  const args = tmuxKeyArgs(key);
  const s = listSessions(config).find((x) => x.sessionId === sessionId);
  if (!s) throw new GoneError("That session isn't running any more");
  if (isDispatcher(s)) throw new Error("Not for Switchboard itself");
  if (isBlocked(s.cwd, config)) throw new Error("Quick replies are off for this folder (blocked). Answer it in its own terminal.");
  if (!s.tmux) throw new Error(`${s.name} doesn't run in tmux, so it can't be answered from here.`);
  const name = s.tmux.split(":")[0];
  if (POCKET_NAME.test(name) && POCKET_KEYS.has(key) && (await pocketUp(config))) {
    try {
      await pocket(config, `/api/sessions/${encodeURIComponent(name)}/key`, { key });
      return;
    } catch (error: any) {
      if (!/unknown key/.test(error?.message)) throw error; // an older Pocket without this key: tmux below
    }
  }
  execFileSync("tmux", [...socketFor(name), "send-keys", "-t", `=${name}:`, ...args], QUIET);
}

/** A refusal the map shows as it is (HTTP status; `blocked` tells the page to stop asking). */
const refuse = (message: string, status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });

/**
 * The read-only terminal view: what the session's tmux pane shows now, colours included (`capture-pane -e`).
 * Never for blocked (client) folders: showing the pane counts as reading it.
 */
export function sessionScreen(sessionId: string, config: Config = loadConfig()): { screen: string } {
  const s = listSessions(config).find((x) => x.sessionId === sessionId);
  if (!s) throw new GoneError("That session isn't running any more");
  if (isDispatcher(s)) throw refuse("Not for Switchboard itself", 403);
  if (isBlocked(s.cwd, config)) throw refuse("The terminal view is off for this folder (blocked). Open it in its own terminal.", 403, { blocked: true });
  if (!s.tmux) throw refuse(`${s.name} doesn't run in tmux, so there's no terminal to show here. Use the command under Details.`, 409);
  const name = s.tmux.split(":")[0];
  let screen: string;
  try {
    screen = execFileSync("tmux", [...socketFor(name), "capture-pane", "-e", "-p", "-t", `=${name}:`], QUIET);
  } catch {
    throw new GoneError(`${s.name}'s terminal isn't there any more`);
  }
  return { screen: screen.replace(/\s+$/, "") };
}

export function sessionChat(sessionId: string, config: Config = loadConfig()) {
  const s = listSessions(config).find((x) => x.sessionId === sessionId);
  if (!s) return { gone: true, canType: false, chat: [] as ChatLine[] };
  return { gone: false, canType: !!s.tmux, chat: readChat(s.transcript, s.cwd).chat.slice(-80) };
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : "";

const spawnName = (command: string) => command.match(/--name\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean);

export function dispatcherFeed(config: Config = loadConfig()) {
  const sessions = listSessions(config);
  const me = sessions.find(isDispatcher);
  const target = tmuxTarget(me);
  const feed = { running: !!me || !!target, state: me?.state, needsTrust: false, contextTokens: me?.contextTokens ?? 0, attach: "", chat: [] as ChatLine[], routes: [] as Route[] };
  if (target && !me) feed.needsTrust = /trust this folder/i.test(screen(target));
  if (target) feed.attach = target.pocket ? `pocket attach ${target.name}` : `sb attach ${target.name}`;
  if (!me?.transcript || !existsSync(me.transcript)) return feed;

  Object.assign(feed, readChat(me.transcript, me.cwd, 120));
  feed.chat = feed.chat.slice(-120);
  feed.routes = feed.routes.slice(-40);
  return feed;
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const base = (p: unknown) => String(p ?? "").split("/").filter(Boolean).slice(-2).join("/");
const unquote = (s: string) => s.replace(/^["']|["']$/g, "");

/** A tool call as one quiet row, like Claude Code's "⏺ Bash(sb ls)" lines. */
/**
 * A Bash command as its label: without the leading `cd <folder> &&` (or `;`) every call starts with, the session's
 * own folder as ".", and the home folder as "~". The full command stays in the row's details.
 */
export function cleanCommand(cmd: string, cwd = ""): string {
  let c = cmd.split("\n")[0].trim();
  for (let i = 0; i < 3; i++) c = c.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "");
  if (cwd) c = c.split(cwd + "/").join("").split(cwd).join(".");
  return c.split(HOME + "/").join("~/").split(HOME).join("~");
}

export function toolRow(name: string, input: any, cwd = ""): NonNullable<ChatLine["tool"]> & { session?: string } {
  const cmd = String(input?.command ?? "");
  const send = cmd.match(/^\s*sb send\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]*)$/);
  if (name === "SendMessage") {
    const to = String(input?.to ?? "").replace(/\s*\[[0-9a-f]+\]$/, "");
    return input?.message ? { name, icon: "💬", label: `Message to ${to}`, detail: String(input.message), session: to }
      : { name, icon: "🔔", label: `Watching ${to}`, detail: "Tell me when it's idle", session: to };
  }
  if (send) { const to = send.slice(1, 4).find(Boolean)!; return { name, icon: "💬", label: `Message to ${to}`, detail: unquote(send[4].trim()), session: to }; }
  if (/^\s*sb spawn\b/.test(cmd)) { const to = spawnName(cmd) ?? "new session"; return { name, icon: "＋", label: `Started ${to}`, detail: cmd, session: to }; }
  if (name === "Bash") {
    // The call's own description says it best ("Run the unit tests"); else the command itself.
    const label = input?.description ? String(input.description) : `$ ${cleanCommand(cmd, cwd)}`;
    return { name, icon: "🔧", label: short(label, 90), detail: [input?.description, cmd].filter(Boolean).join("\n\n") };
  }
  if (name === "Read") return { name, icon: "📄", label: `Read ${base(input?.file_path)}`, detail: String(input?.file_path ?? "") };
  if (name === "Edit" || name === "MultiEdit") return { name, icon: "✏️", label: `Edit ${base(input?.file_path)}`, detail: input?.old_string != null ? `- ${input.old_string}\n+ ${input.new_string}` : String(input?.file_path ?? "") };
  if (name === "Write") return { name, icon: "📝", label: `Write ${base(input?.file_path)}`, detail: String(input?.file_path ?? "") };
  if (name === "Grep" || name === "Glob") return { name, icon: "🔍", label: `${name}: ${short(String(input?.pattern ?? ""), 60)}`, detail: JSON.stringify(input, null, 1) };
  if (name === "WebFetch" || name === "WebSearch") return { name, icon: "🌐", label: `${name}: ${short(String(input?.url ?? input?.query ?? ""), 60)}`, detail: JSON.stringify(input, null, 1) };
  if (name === "Agent" || name === "Task") return { name, icon: "🤖", label: `Agent: ${short(String(input?.description ?? ""), 60)}`, detail: String(input?.prompt ?? "") };
  if (name === "ListAgents") return { name, icon: "👥", label: "Listed sessions", detail: "" };
  if (name === "TodoWrite") return { name, icon: "☑️", label: "Updated the to-do list", detail: (input?.todos ?? []).map((t: any) => `${t.status === "completed" ? "✓" : "·"} ${t.content}`).join("\n") };
  return { name, icon: "⚙️", label: short(name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ""), 60), detail: short(JSON.stringify(input ?? {}, null, 1), 2000) };
}

/** Who a notice is from: cross-session messages carry from-name; idle notices quote the name first. */
export function noticeLine(raw: string): { text: string; session?: string } {
  const from = raw.match(/from-name="([^"]+)"/)?.[1];
  if (from) return { session: from, text: short(raw.replace(/<[^>]+>/g, "").trim(), 3000) };
  const idle = raw.match(/^\[Cross-session idle notice\] "([^"]+)"/)?.[1];
  if (idle) {
    const at = raw.match(/turn at (\d\d?:\d\d)/)?.[1], said = raw.match(/«([\s\S]*?)»/)?.[1];
    return { session: idle, text: `Finished${at ? " at " + at : ""}${said ? ": " + said : ""}` };
  }
  return { text: short(raw.replace(/<[^>]+>/g, "").trim(), 400) };
}

/** "→ Misc: sent…" / "＋ KSP mod research (…)": the dispatcher's own lines about one session. */
export const replySession = (text: string) => text.match(/^(?:→|＋|\+)\s*([^:(\n*]{1,60}?)\s*[:(—-]/)?.[1]?.trim();

/** Chat lines (what was said, both ways) and routes (messages sent / sessions started) from a transcript tail. */
/**
 * The tail is read in a growing window: one screenshot Claude read is a single 600 KB+ line, so a fixed 512 KB tail
 * could hold no chat at all (and a message you sent then never showed as picked up).
 */
export function readChat(transcript: string, cwd = "", want = 80) {
  if (!existsSync(transcript)) return { chat: [] as ChatLine[], routes: [] as Route[] };
  const size = statSync(transcript).size;
  for (let bytes = 512 * 1024; ; bytes *= 4) {
    const got = readChatTail(readTail(transcript, bytes), cwd);
    if (got.chat.length >= want || bytes >= size || bytes >= 16 * 1024 * 1024) return got;
  }
}

function readChatTail(tail: string, cwd: string) {
  const chat: ChatLine[] = [], routes: Route[] = [];
  const asks = new Map<string, ChatLine>(); // AskUserQuestion tool_use id → its card, to fill in the answers
  for (const line of tail.split("\n")) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // isCompactSummary: the summary Claude Code writes as a user line after a /compact, not something Vedran typed.
    if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) continue;
    const at = Date.parse(entry.timestamp) || 0;
    const content = entry.message?.content;
    // A message typed while the session was busy is taken in mid-turn and only recorded as a queued_command attachment,
    // never as a user line (2.1.300). Task notifications use the same attachment, but start with "<task-notification>".
    const queued = entry.type === "attachment" && entry.attachment?.type === "queued_command" && entry.attachment.commandMode === "prompt" ? entry.attachment : undefined;
    if (queued) {
      const text = (typeof queued.prompt === "string" ? queued.prompt : textOf(queued.prompt)).trim();
      if (text && !text.startsWith("<") && queued.origin?.kind !== "task") chat.push({ id: entry.uuid, at, role: "you", text, queued: true });
      continue;
    }
    if (entry.type === "user" && Array.isArray(content)) for (const b of content) {
      const card = b?.type === "tool_result" ? asks.get(b.tool_use_id) : undefined;
      if (card) card.answers = entry.toolUseResult?.answers ?? { "": textOf(b.content) || String(b.content ?? "") };
    }
    if (entry.type === "user") {
      const text = textOf(content).trim();
      if (!text) continue;
      // `!cmd` (bash mode) and /commands are recorded as tagged lines; their output follows in the next one.
      const bash = text.match(/^<bash-input>([\s\S]*?)<\/bash-input>/);
      const slash = text.match(/^<command-name>(\/[^<]+)<\/command-name>/);
      const out = text.match(/^<(?:bash-stdout|local-command-stdout)>([\s\S]*?)<\/(?:bash-stdout|local-command-stdout)>(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?/);
      if (bash) { chat.push({ id: entry.uuid, at, role: "shell", text: `! ${bash[1].trim()}` }); continue; }
      if (slash) { chat.push({ id: entry.uuid, at, role: "shell", text: `${slash[1].trim()} ${text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim() ?? ""}`.trim() }); continue; }
      if (out) {
        const last = chat.at(-1);
        // eslint-disable-next-line no-control-regex
        if (last?.role === "shell") last.output = [out[1], out[2]].filter((x) => x?.trim()).join("\n").replace(/\x1b\[[0-9;]*m/g, "").trim();
        continue;
      }
      if (text.startsWith("<cross-session") || text.startsWith("[Cross-session")) {
        chat.push({ id: entry.uuid, at, role: "notice", ...noticeLine(text) });
      } else if (!text.startsWith("<")) {
        // Some versions also write the queued message as a user line afterwards: show it once.
        const prev = chat.findLast((c) => c.role === "you");
        if (prev?.queued && prev.text === text && at - prev.at < 10 * 60_000) { delete prev.queued; continue; }
        chat.push({ id: entry.uuid, at, role: "you", text });
      }
    }
    if (entry.type === "assistant" && Array.isArray(content)) {
      for (const [index, block] of content.entries()) {
        // Stable ids (entry uuid + block index), so the page can add new lines without redrawing old ones.
        if (block.type === "text" && block.text.trim()) chat.push({ id: `${entry.uuid}-${index}`, at, role: "switchboard", text: block.text.trim(), session: replySession(block.text.trim()) });
        if (block.type !== "tool_use") continue;
        const input = block.input ?? {};
        if (block.name === "AskUserQuestion" && Array.isArray(input.questions)) {
          const card: ChatLine = { id: `${entry.uuid}-${index}`, at, role: "ask", text: input.questions.map((q: any) => q.question).join("\n"), questions: input.questions };
          chat.push(card); asks.set(block.id, card);
          continue;
        }
        const { session, ...tool } = toolRow(block.name, input, cwd);
        chat.push({ id: `${entry.uuid}-${index}`, at, role: "tool", text: tool.label, tool, session });
        if (block.name === "SendMessage" && input.message && input.to) {
          routes.push({ id: block.id, at, kind: "send", target: String(input.to).replace(/\s*\[[0-9a-f]+\]$/, ""), text: String(input.message).slice(0, 200) });
        }
        const sendCmd = block.name === "Bash" ? String(input.command ?? "").match(/^\s*sb send\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]*)$/) : null;
        if (sendCmd) {
          const to = sendCmd.slice(1, 4).find(Boolean)!;
          routes.push({ id: block.id, at, kind: "send", target: to, text: sendCmd[4].replace(/^["']|["']$/g, "").slice(0, 200) });
        }
        if (block.name === "Bash" && /^\s*sb spawn\b/.test(input.command ?? "")) {
          const name = spawnName(input.command);
          if (name) routes.push({ id: block.id, at, kind: "spawn", target: name, text: input.command.replace(/^.*?--name\s+("[^"]+"|'[^']+'|\S+)/, "").replace(/--(cwd|group)\s+\S+/g, "").trim().slice(0, 200) });
        }
      }
    }
  }
  return { chat, routes };
}
