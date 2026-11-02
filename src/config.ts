import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
export const STATE_DIR = process.env.SWITCHBOARD_STATE_DIR ?? path.join(HOME, ".switchboard");

export const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME);

export interface Config {
  /** Folders the dispatcher must never start sessions in (other accounts, client data). Prefix match; a trailing * matches any suffix. */
  blocked: string[];
  /** Folder prefix → Claude profile. The longest matching prefix wins; anything else uses "claude". */
  profiles: Record<string, string>;
  /** Profile name → CLAUDE_CONFIG_DIR ("" = the default ~/.claude). */
  configDirs: Record<string, string>;
  /** Profiles whose sessions `sb send` may type into (SendMessage only reaches the profile the dispatcher runs on). */
  sendProfiles: string[];
  /** Most sessions Switchboard itself may have alive at once. */
  maxLiveSpawned: number;
  /** Where new sessions start: "auto" (Pocket if it's running, else our own tmux), "tmux", "pocket", or "bg" (claude --bg). */
  backend: "auto" | "pocket" | "tmux" | "bg";
  pocketUrl: string;
  pocketStateDir: string;
  /** Context window used for the %. */
  contextWindow: number;
  /** Context size (tokens) from which a session should be handed off or compacted: every turn re-reads all of it. */
  handoffTokens: number;
  /** An idle session with no activity for this many hours counts as stale. */
  staleHours: number;
  port: number;
  /** Tailscale logins (e.g. you@example.com) allowed in through `tailscale serve`; empty = only this Mac. */
  remoteLogins: string[];
  /** HTTPS port `sb remote on` publishes the map on, tailnet only. */
  remotePort: number;
  /** Folder prefix → look on the map; the longest match wins. A trailing * matches any suffix. */
  domains: { match: string; domain: string; icon: string; color: string }[];
  /** Per-session look, by session name: { "PZ": { "icon": "🧟", "color": "#16a34a" } }. */
  sessionStyles: Record<string, { icon?: string; color?: string }>;
  /** Words Whisper should spell right (names, jargon). Live session names are added automatically. */
  vocabulary: string;
  /** Fixes applied to every transcript, heard → meant (whole words, any case), e.g. {"meer za": "Mirza"}. */
  corrections: Record<string, string>;
  /** Where attached images are saved (a "switchboard" subfolder is used). Pocket-started sessions can read here. */
  uploadsDir: string;
  /** Delete Switchboard's own uploads older than this many days (0 = keep). */
  uploadKeepDays: number;
}

const DEFAULTS: Config = {
  // Personal values (blocked client folders, extra profiles, your folder layout) belong in
  // ~/.switchboard/config.json, not here: see config.example.json.
  blocked: [],
  profiles: {},
  configDirs: { claude: "" },
  sendProfiles: ["claude"],
  maxLiveSpawned: 5,
  backend: "auto",
  pocketUrl: "http://127.0.0.1:8787",
  pocketStateDir: "~/.pocket-sessions",
  contextWindow: 1_000_000,
  handoffTokens: 300_000,
  staleHours: 4,
  port: 8790,
  remoteLogins: [],
  remotePort: 8443,
  domains: [
    { match: "~/Projects", domain: "tools", icon: "🛠️", color: "#ea580c" },
    { match: "~", domain: "home", icon: "🏠", color: "#a16207" },
  ],
  sessionStyles: {},
  vocabulary: "Switchboard, Claude, Pocket, hand off, worktree",
  corrections: {},
  uploadsDir: "~/.switchboard/uploads",
  uploadKeepDays: 7,
};

export function loadConfig(): Config {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path.join(STATE_DIR, "config.json"), "utf8")) };
  } catch {
    return DEFAULTS;
  }
}

export function profileFor(cwd: string, config: Config): string {
  let best = "", profile = "claude";
  for (const [prefix, name] of Object.entries(config.profiles)) {
    const p = expand(prefix);
    if ((cwd === p || cwd.startsWith(p + "/")) && p.length > best.length) [best, profile] = [p, name];
  }
  return profile;
}

export function isBlocked(cwd: string, config: Config): string | undefined {
  return config.blocked.find((rule) => {
    const p = expand(rule);
    return p.endsWith("*") ? cwd.startsWith(p.slice(0, -1)) : cwd === p || cwd.startsWith(p + "/");
  });
}

export function styleFor(name: string, cwd: string, config: Config) {
  let best = { match: "", domain: "other", icon: "💬", color: "#64748b" }, bestLen = -1;
  for (const d of config.domains) {
    const p = expand(d.match);
    const hit = p.endsWith("*") ? cwd.startsWith(p.slice(0, -1)) : cwd === p || cwd.startsWith(p + "/");
    if (hit && p.length > bestLen) [best, bestLen] = [d, p.length];
  }
  const own = config.sessionStyles[name] ?? {};
  return { domain: best.domain, icon: own.icon ?? best.icon, color: own.color ?? best.color };
}
