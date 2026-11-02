import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { HOME, STATE_DIR, expand, isBlocked, loadConfig, type Config } from "./config.ts";
import { GoneError, isDispatcher, sayTo } from "./dispatcher.ts";
import { listSessions, type Session } from "./sessions.ts";
import { spawnSession, startInOwnTmux, type SpawnResult } from "./spawn.ts";
import { socketFor, uniqueName } from "./tmux.ts";

/**
 * What the map and the phone can do to sessions beyond typing into them: start a new one in a folder you pick,
 * rename one, end one, or take over one that isn't in tmux. Spawning keeps every guard in spawnSession (the CLI's too).
 */

/** A refusal the page shows as it is (HTTP status; `blocked` for blocked folders). */
const refuse = (message: string, status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });

function findSession(sessionId: string, config: Config): Session {
  const s = listSessions(config).find((x) => x.sessionId === sessionId);
  if (!s) throw new GoneError("That session isn't running any more");
  if (isDispatcher(s)) throw refuse("Not for Switchboard itself", 403);
  return s;
}

/** Folders whose immediate children are offered when starting a session (only the ones that exist). */
export const PROJECT_ROOTS = ["Projects", "WebstormProjects", "GameProjects"];

export interface Folder { path: string; label: string; recent: boolean }

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * Folders for "＋ New": where sessions run now and where Switchboard started them (most recent first), then the
 * project folders under PROJECT_ROOTS (most recently changed first). Deduped; blocked folders and the dispatcher's
 * own folder are never offered; only folders inside the home folder (spawnSession refuses anything else).
 */
export function listFolders(config: Config = loadConfig()): Folder[] {
  const recent: { path: string; at: number }[] = [];
  for (const s of listSessions(config)) if (!isDispatcher(s)) recent.push({ path: s.cwd, at: s.lastActivity });
  try {
    for (const line of readFileSync(path.join(STATE_DIR, "spawned.jsonl"), "utf8").split("\n")) {
      try { const e = JSON.parse(line); if (typeof e.cwd === "string") recent.push({ path: e.cwd, at: Number(e.at) || 0 }); } catch {}
    }
  } catch {}
  recent.sort((a, b) => b.at - a.at);
  const children: { path: string; at: number }[] = [];
  for (const root of PROJECT_ROOTS) {
    const dir = path.join(HOME, root);
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const p = path.join(dir, name);
      if (name.startsWith(".") || !isDir(p)) continue;
      children.push({ path: p, at: statSync(p).mtimeMs });
    }
  }
  children.sort((a, b) => b.at - a.at);
  const seen = new Set<string>(), out: Folder[] = [];
  const dispatcherDir = path.join(STATE_DIR, "dispatcher");
  for (const [list, isRecent] of [[recent, true], [children, false]] as const) {
    for (const { path: p } of list) {
      if (seen.has(p) || p === dispatcherDir || !(p + "/").startsWith(HOME + "/") || isBlocked(p, config) || !isDir(p)) continue;
      seen.add(p);
      out.push({ path: p, label: "~" + p.slice(HOME.length), recent: isRecent });
    }
  }
  return out.slice(0, 300);
}

/**
 * "＋ New" on the map or phone: a folder, an optional name and a first prompt, through spawnSession and all its guards.
 * Without a name the session is named after the folder (with -2, -3… while a live one already has that name).
 */
export async function startFromPage(body: { cwd?: unknown; name?: unknown; prompt?: unknown }, config: Config = loadConfig()): Promise<SpawnResult> {
  const cwd = String(body.cwd ?? "").trim(), prompt = String(body.prompt ?? "");
  // Control characters (a pasted newline) never go into a name.
  let name = String(body.name ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 60);
  if (!cwd) throw Object.assign(new Error("Pick a folder first"), { status: 400 });
  if (!name) {
    const live = new Set(listSessions(config).map((s) => s.name));
    const base = path.basename(cwd) || "session";
    name = base;
    for (let n = 2; live.has(name); n++) name = `${base}-${n}`;
  }
  try {
    return await spawnSession({ cwd, name, prompt }, config);
  } catch (error: any) {
    throw Object.assign(error, { status: error.status ?? 400 }); // a guard said no: show its text as it is
  }
}

/** Rename: types `/rename <name>` into the session, through the normal typing path. tmux sessions only, never blocked folders. */
export async function renameSession(sessionId: string, name: unknown, config: Config = loadConfig()): Promise<{ name: string }> {
  const clean = String(name ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 60);
  if (!clean) throw refuse("Give it a name", 400);
  const s = findSession(sessionId, config);
  if (isBlocked(s.cwd, config)) throw refuse("Renaming is off for this folder (blocked): it types into the session. Rename it in its own terminal.", 403, { blocked: true });
  if (!s.tmux) throw refuse(`${s.name} doesn't run in tmux, so it can't be renamed from here. Take it over first, or use /rename in its terminal.`, 409);
  await sayTo(sessionId, `/rename ${clean}`, config);
  return { name: clean };
}

/** tmux sessions End may close: ours (sb-*, `tmux -L switchboard`) and Pocket's (pk-*, `tmux -L pocket`). Nothing else. */
export const ENDABLE = /^(sb|pk)-[A-Za-z0-9._-]+$/;

/** End: kills the session's tmux session (Claude Code exits; its conversation stays resumable). sb-* and pk-* only. */
export function endSession(sessionId: string, config: Config = loadConfig()): { ended: string } {
  const s = findSession(sessionId, config);
  if (!s.tmux) throw refuse(`${s.name} doesn't run in tmux: end it in its own terminal.`, 409);
  const name = s.tmux.split(":")[0];
  if (!ENDABLE.test(name)) throw refuse(`"${name}" isn't a Switchboard (sb-*) or Pocket (pk-*) session, so it isn't ended from here.`, 403);
  try {
    execFileSync("tmux", [...socketFor(name), "kill-session", "-t", `=${name}:`], { stdio: ["ignore", "ignore", "pipe"] });
  } catch {
    throw new GoneError(`${s.name}'s tmux session isn't there any more`);
  }
  return { ended: name };
}

/**
 * Take over: a session started outside tmux (plain `claude`) can only be read from here. This resumes its conversation
 * (`claude --resume <id>`) in our own tmux, in its folder and with its profile's CLAUDE_CONFIG_DIR, so it can be typed
 * into. The original terminal should be closed first: two processes appending to one transcript mix it up (the page's
 * confirm says so). Never in blocked folders.
 */
export function takeOver(sessionId: string, config: Config = loadConfig()): { tmux: string; attach: string } {
  const s = findSession(sessionId, config);
  const blocked = isBlocked(s.cwd, config);
  if (blocked) throw refuse(`BLOCKED: ${s.cwd} matches "${blocked}". Continue it in its own terminal.`, 403, { blocked: true });
  if (s.tmux) throw refuse(`${s.name} already runs in tmux: type into it directly.`, 409);
  if (s.kind === "bg") throw refuse(`${s.name} is a background session: open it with claude attach.`, 409);
  if (!/^[A-Za-z0-9-]+$/.test(s.sessionId)) throw refuse("That session id doesn't look right", 400);
  // The profile's config dir from config, else the one its registry entry lives in (<dir>/projects/<slug>/<id>.jsonl).
  const own = path.dirname(path.dirname(path.dirname(s.transcript)));
  const configDir = s.profile in config.configDirs ? expand(config.configDirs[s.profile]) : own === path.join(HOME, ".claude") ? "" : own;
  const tname = uniqueName(s.profile, s.cwd);
  startInOwnTmux(tname, s.cwd, configDir, ["--resume", s.sessionId], [], config);
  return { tmux: tname, attach: `sb attach ${tname}` };
}

/** A session Switchboard started that isn't in the registry yet because it sits at Claude's first-run "trust this folder" prompt. */
export interface TrustWait { name: string; tmux: string; cwd: string; profile: string; at: number }

const TRUST_PROMPT = /trust this folder/i;
const tmuxOf = (attach: unknown) => String(attach ?? "").match(/(?:attach -t|sb attach) (\S+)$/)?.[1];
const paneText = (tmux: string) => {
  try {
    return execFileSync("tmux", [...socketFor(tmux), "capture-pane", "-p", "-t", `=${tmux}:`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { return ""; } // ended, or its tmux server isn't running
};

/**
 * Spawns from the last 6 h (`spawned.jsonl`) whose tmux session is alive, matches no registered session, and shows the
 * trust prompt. Blocked folders are skipped before their pane is read. The newest spawn wins when two share a tmux name.
 */
export function waitingForTrust(config: Config = loadConfig(), sessions: Session[] = listSessions(config)): TrustWait[] {
  const registered = new Set(sessions.map((s) => s.tmux?.split(":")[0]).filter(Boolean));
  const byTmux = new Map<string, TrustWait>();
  try {
    for (const line of readFileSync(path.join(STATE_DIR, "spawned.jsonl"), "utf8").split("\n")) {
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      const tmux = tmuxOf(e.attach);
      if (!tmux || !ENDABLE.test(tmux) || !(Date.now() - Number(e.at) < 6 * 3_600_000)) continue;
      byTmux.set(tmux, { name: String(e.name ?? tmux), tmux, cwd: String(e.cwd ?? ""), profile: String(e.profile ?? ""), at: Number(e.at) });
    }
  } catch {}
  return [...byTmux.values()].filter((w) => !registered.has(w.tmux) && !isBlocked(w.cwd, config) && TRUST_PROMPT.test(paneText(w.tmux)));
}

/** "Trust it" on a waiting session: picks "Yes, I trust this folder" (the second option), like acceptTrust for the dispatcher. */
export function trustSession(tmux: string, config: Config = loadConfig()): { trusted: string } {
  const w = waitingForTrust(config).find((x) => x.tmux === tmux);
  if (!w) throw refuse("No trust prompt showing there any more", 404);
  execFileSync("tmux", [...socketFor(tmux), "send-keys", "-t", `=${tmux}:`, "Down", "Enter"]);
  return { trusted: w.name };
}
