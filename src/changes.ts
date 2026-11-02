import { execFileSync } from "node:child_process";
import { isBlocked, loadConfig, type Config } from "./config.ts";
import { GoneError, isDispatcher } from "./dispatcher.ts";
import { listSessions, type Session } from "./sessions.ts";

/**
 * The sheet's read-only Changes view: what `git status` says changed in a session's folder, and the diff of one file.
 * Never for blocked (client) folders: refused before git ever runs, like the terminal view.
 */

export interface ChangedFile { path: string; status: string }

/** Diffs bigger than this are cut (a phone can't show more anyway). */
export const MAX_DIFF = 200 * 1024;

const refuse = (message: string, status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });

/**
 * git, read-only: no optional locks (a session may be committing at the same time), and no fsmonitor hook from the repo's
 * config, no external diff drivers or textconv (`--no-ext-diff --no-textconv` on every diff). okCodes: `git diff --no-index` exits 1 when the files differ, which is the normal case here.
 */
function git(cwd: string, args: string[], okCodes = [0]): string {
  try {
    return execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-C", cwd, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024, timeout: 10_000 });
  } catch (e: any) {
    if (okCodes.includes(e.status) && typeof e.stdout === "string") return e.stdout;
    throw e;
  }
}

function sessionFor(sessionId: string, config: Config): Session {
  const s = listSessions(config).find((x) => x.sessionId === sessionId);
  if (!s) throw new GoneError("That session isn't running any more");
  if (isDispatcher(s)) throw refuse("Not for Switchboard itself", 403);
  if (isBlocked(s.cwd, config)) throw refuse("The Changes view is off for this folder (blocked). Look at it in its own terminal.", 403, { blocked: true });
  return s;
}

/** `git status --porcelain -z` parsed: paths are relative to the repository root; renames give the new path. */
export function parseStatus(raw: string): ChangedFile[] {
  const out: ChangedFile[] = [], parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const status = rec.slice(0, 2), file = rec.slice(3);
    if (status[0] === "R" || status[0] === "C") i++; // the next record is the old path
    out.push({ path: file, status: status.trim() || status });
  }
  return out;
}

function statusOf(cwd: string): { repo: boolean; root?: string; branch?: string; files: ChangedFile[] } {
  let root: string;
  try { root = git(cwd, ["rev-parse", "--show-toplevel"]).trim(); } catch { return { repo: false, files: [] }; }
  const files = parseStatus(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  let branch: string | undefined;
  try { branch = git(root, ["branch", "--show-current"]).trim() || undefined; } catch {}
  return { repo: true, root, branch, files };
}

/** GET /api/session/changes: the changed files in the session's repository. */
export function sessionChanges(sessionId: string, config: Config = loadConfig()) {
  const s = sessionFor(sessionId, config);
  const { repo, branch, files } = statusOf(s.cwd);
  return { repo, branch, total: files.length, files: files.slice(0, 500) };
}

/**
 * GET /api/session/diff: one file's diff against HEAD (staged and unstaged together); an untracked file shows as all new.
 * `file` must be one of the paths status returned, so nothing else in (or outside) the repository can be read.
 */
export function sessionDiff(sessionId: string, file: string, config: Config = loadConfig()): { file: string; status: string; diff: string; cut: boolean } {
  const s = sessionFor(sessionId, config);
  const st = statusOf(s.cwd);
  const entry = st.files.find((f) => f.path === file);
  if (!st.root || !entry) throw refuse("That file has no changes", 404);
  let diff: string;
  if (entry.status === "??") diff = git(st.root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", entry.path], [0, 1]);
  else {
    try { diff = git(st.root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD", "--", entry.path]); }
    catch { diff = git(st.root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--cached", "--", entry.path]); } // no commit yet: what's staged
  }
  const cut = diff.length > MAX_DIFF;
  return { file: entry.path, status: entry.status, diff: cut ? diff.slice(0, MAX_DIFF) : diff, cut };
}
