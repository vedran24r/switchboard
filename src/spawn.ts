import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { HOME, STATE_DIR, expand, isBlocked, loadConfig, profileFor, type Config } from "./config.ts";
import { listSessions } from "./sessions.ts";
import { OWN_TMUX, shQuote, uniqueName } from "./tmux.ts";

export interface SpawnRequest {
  cwd: string;
  name: string;
  prompt: string;
  /** Sessions split out of the same dictated message share a group, so the map draws them together. */
  group?: string;
}

export interface SpawnResult {
  name: string;
  backend: "pocket" | "tmux" | "bg";
  profile: string;
  cwd: string;
  attach: string;
}

const fail = (message: string): never => {
  throw new Error(message);
};

function pocketKey(config: Config): string | undefined {
  try {
    return readFileSync(path.join(expand(config.pocketStateDir), "access-key"), "utf8").trim();
  } catch {}
}

async function pocketUp(config: Config, key: string | undefined): Promise<boolean> {
  if (!key) return false;
  try {
    const res = await fetch(`${config.pocketUrl}/api/launch-options`, { headers: { cookie: `pocket_key=${key}` }, signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Starts `claude <args>` in our own tmux, through your login shell so the session gets your PATH and settings, like a
 * terminal would. Every argument is shQuote'd. Used by the "tmux" spawn backend and by taking over a read-only session.
 * configDir: CLAUDE_CONFIG_DIR for the session ("" = the default ~/.claude, left unset).
 */
export function startInOwnTmux(tname: string, cwd: string, configDir: string, args: string[], tail: string[] = [], config: Config = loadConfig()) {
  const uploads = expand(config.uploadsDir);
  mkdirSync(uploads, { recursive: true });
  const shell = process.env.SHELL || "/bin/zsh";
  // SWITCHBOARD_CLAUDE_BIN: tests only (a login shell rebuilds PATH, so a fake `claude` on PATH isn't enough).
  const bin = process.env.SWITCHBOARD_CLAUDE_BIN ? shQuote(process.env.SWITCHBOARD_CLAUDE_BIN) : "command claude";
  const claude = `exec ${bin} ${[...args, "--add-dir", uploads, ...tail].map(shQuote).join(" ")}`;
  try {
    execFileSync("tmux", [...OWN_TMUX, "new-session", "-d", "-s", tname, "-c", cwd, "-x", "120", "-y", "40",
      ...(configDir ? ["-e", `CLAUDE_CONFIG_DIR=${configDir}`] : []), shell, "-lic", claude], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e: any) { fail(`tmux couldn't start it: ${String(e.stderr || e.message).trim()}`); }
}

export async function spawnSession(req: SpawnRequest, config: Config = loadConfig()): Promise<SpawnResult> {
  const name = req.name.trim().slice(0, 60) || fail("A name is required");
  const prompt = req.prompt.trim() || fail("A prompt is required");
  let cwd = expand(req.cwd.trim());
  try {
    cwd = realpathSync(cwd);
  } catch {
    fail(`Folder doesn't exist: ${cwd}`);
  }
  if (!statSync(cwd).isDirectory() || !(cwd + "/").startsWith(HOME + "/")) fail(`Pick a folder inside ${HOME}: ${cwd}`);

  const blocked = isBlocked(cwd, config);
  if (blocked) fail(`BLOCKED: ${cwd} matches "${blocked}" (other account / client data). Vedran starts these himself: cd ${cwd} && claude`);

  const live = listSessions(config);
  if (live.some((s) => s.name === name)) fail(`A live session is already called "${name}". Message it instead, or pick another name.`);
  const spawnedAlive = live.filter((s) => s.spawnedBy).length;
  if (spawnedAlive >= config.maxLiveSpawned) {
    fail(`LIMIT: ${spawnedAlive} Switchboard sessions are alive (max ${config.maxLiveSpawned}). Ask Vedran which to end, or raise maxLiveSpawned in ~/.switchboard/config.json.`);
  }

  const profile = profileFor(cwd, config);
  const key = pocketKey(config);
  const usePocket = config.backend === "pocket" || (config.backend === "auto" && (await pocketUp(config, key)));
  let result: SpawnResult;

  if (usePocket) {
    const res = await fetch(`${config.pocketUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `pocket_key=${key ?? ""}` },
      body: JSON.stringify({ cwd, profile, name, prompt }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) fail(`Pocket refused: ${body.error ?? res.status}`);
    result = { name, backend: "pocket", profile, cwd, attach: `tmux -L pocket attach -t ${body.name}` };
  } else if (config.backend !== "bg") {
    const tname = uniqueName(profile, cwd);
    startInOwnTmux(tname, cwd, config.configDirs[profile] ? expand(config.configDirs[profile]) : "", ["-n", name], ["--", prompt], config);
    result = { name, backend: "tmux", profile, cwd, attach: `sb attach ${tname}` };
  } else {
    const configDir = config.configDirs[profile];
    const env = { ...process.env, ...(configDir ? { CLAUDE_CONFIG_DIR: expand(configDir) } : {}) };
    const run = spawnSync("claude", ["--bg", "-n", name, "--", prompt], { cwd, env, encoding: "utf8", timeout: 60_000 });
    if (run.status !== 0) fail(`claude --bg failed: ${(run.stderr || run.stdout || run.error?.message || "").trim()}`);
    const attachEnv = configDir ? `CLAUDE_CONFIG_DIR=${configDir} ` : "";
    result = { name, backend: "bg", profile, cwd, attach: `${attachEnv}claude attach "${name}"` };
  }

  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(path.join(STATE_DIR, "spawned.jsonl"), JSON.stringify({ ...result, group: req.group ?? name, at: Date.now() }) + "\n");
  return result;
}
