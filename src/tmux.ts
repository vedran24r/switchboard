import { execFileSync } from "node:child_process";
import path from "node:path";

/** Switchboard's own tmux server: sb-* sessions (`sb run`, map/phone spawns) and the dispatcher. */
export const TMUX_CONF = path.join(import.meta.dirname, "..", "tmux.conf");
export const OWN_TMUX = ["-L", process.env.SWITCHBOARD_TMUX_SOCKET || "switchboard", "-f", TMUX_CONF]; // tests use their own socket

/** Which tmux server a session name lives on: Pocket's pk-*, else ours. */
export const socketFor = (name: string) => (name.startsWith("pk-") ? ["-L", "pocket"] : OWN_TMUX);

/** One shell word, safe inside `sh -c` whatever it contains ($, backticks, quotes). */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "") || "session";

const has = (name: string) => {
  try { execFileSync("tmux", [...OWN_TMUX, "has-session", "-t", `=${name}:`], { stdio: "ignore" }); return true; } catch { return false; }
};
/** sb-<profile>-<folder>, then -2, -3… if taken: the same names `sb run` gives. */
export function uniqueName(profile: string, cwd: string): string {
  const base = `sb-${profile.toLowerCase().replace(/[^a-z0-9]/g, "")}-${slug(path.basename(cwd))}`;
  let name = base;
  for (let n = 2; has(name); n++) name = `${base}-${n}`;
  return name;
}
