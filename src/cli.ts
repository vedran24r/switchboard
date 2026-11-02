import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { HOME, loadConfig } from "./config.ts";
import { say, sendByName, startDispatcher } from "./dispatcher.ts";
import { listSessions } from "./sessions.ts";
import { spawnSession } from "./spawn.ts";
import { serve } from "./server.ts";

const HELP = `sb — Switchboard: one voice channel, many Claude sessions

  sb up                     start the dispatcher + the map and open it: talk there
  sb map                    serve only the map (http://127.0.0.1:8790)
  sb say TEXT               send TEXT to the dispatcher from a terminal
  sb pulse NAME... [--kind needs-you|continue|info]
                            make those bubbles pulse on the map for ~1.5 s (all tabs); types nothing anywhere
  sb send NAME TEXT         type TEXT into session NAME (for profiles SendMessage can't reach, e.g. game;
                            allowed profiles: sendProfiles in ~/.switchboard/config.json; blocked folders stay blocked)
  sb ls [--json]            every live session: state, context, folder
  sb remote on|off|status   open the map on your phone: HTTPS on your tailnet only (tailscale serve,
                            port remotePort; logins allowed: remoteLogins in ~/.switchboard/config.json)
  sb spawn --cwd DIR --name NAME [--group G] PROMPT
                            start a session with a first task (guarded: blocked folders, max live
                            sessions, name clashes; in Pocket if it's running, else in Switchboard's tmux)
  sb run [claude args...]   start Claude Code here inside Switchboard's tmux, so the map and phone can type
                            into it (closing the terminal ends it); for ~/.zshrc: claude() { sb run "$@"; }
  sb attach NAME            reattach to an sb-* session (prefix + d detaches and keeps it running)
  sb sessions               list sb-* sessions
`;

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** The Tailscale CLI: on PATH, or inside the Mac app. A leftover /usr/local/bin/tailscale whose app was removed
 *  doesn't count: the binary has to answer `version`. */
function tailscale(args: string[]) {
  const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  const works = (b: string) => spawnSync(b, ["version"], { encoding: "utf8" }).status === 0;
  const bin = works("tailscale") ? "tailscale" : existsSync(app) && works(app) ? app : undefined;
  if (!bin) throw new Error("Tailscale isn't installed (no working tailscale on PATH, no Tailscale.app).");
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tailscale ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest.splice(i, 2)[1] : undefined;
  };

  switch (command) {
    case "ls": {
      const sessions = listSessions();
      if (rest.includes("--json")) return console.log(JSON.stringify(sessions, null, 2));
      for (const s of sessions) {
        const ctx = `${Math.round(s.contextTokens / 1000)}k`.padStart(5) + (s.needsHandoff ? "!" : " ");
        console.log(`${s.state.padEnd(9)} ${ctx} ${ago(s.lastActivity).padStart(4)}  ${s.name.padEnd(30)} ${s.cwd.replace(HOME, "~")}`);
      }
      return;
    }
    case "spawn": {
      const cwd = flag("cwd"), name = flag("name"), group = flag("group");
      const prompt = rest.join(" ");
      if (!cwd || !name || !prompt) throw new Error("usage: sb spawn --cwd DIR --name NAME [--group G] PROMPT");
      const result = await spawnSession({ cwd, name, prompt, group });
      return console.log(JSON.stringify(result));
    }
    case "map":
      return serve(Number(flag("port")) || undefined);
    case "up": {
      // One command: the dispatcher (in tmux) + the map, then open the map in the browser.
      console.log(await startDispatcher());
      const port = Number(flag("port")) || loadConfig().port;
      const up = await fetch(`http://127.0.0.1:${port}/api/state`).then(() => true, () => false);
      if (!up) serve(port);
      spawnSync("open", [`http://127.0.0.1:${port}`]);
      if (up) console.log(`Map already running: http://127.0.0.1:${port}`);
      return;
    }
    case "send": {
      const [name, ...words] = rest;
      return console.log(await sendByName(name ?? "", words.join(" ")));
    }
    case "pulse": {
      // Make bubbles pulse on the map (every open tab). Never types into a session.
      const kind = flag("kind") ?? "info";
      if (!["needs-you", "continue", "info"].includes(kind)) throw new Error("--kind must be needs-you, continue or info");
      if (!rest.length) throw new Error("usage: sb pulse NAME [NAME...] [--kind needs-you|continue|info]");
      const port = Number(flag("port")) || loadConfig().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/pulse`, {
        method: "POST", headers: { "content-type": "application/json", "x-switchboard": "1" }, body: JSON.stringify({ names: rest, kind }),
      }).catch(() => undefined);
      if (!res) throw new Error(`The map isn't running on port ${port} (start it: sb map), nothing pulsed.`);
      if (!res.ok) throw new Error(`The map answered HTTP ${res.status}; it may be an older version (restart it), nothing pulsed.`);
      const { pulsed, unknown } = (await res.json()) as { pulsed: string[]; unknown: string[] };
      if (unknown.length) console.error(`warning: no live session called ${unknown.map((n) => `"${n}"`).join(", ")} (ignored)`);
      return console.log(pulsed.length ? `pulsed (${kind}): ${pulsed.join(", ")}` : "nothing pulsed");
    }
    case "remote": {
      // Same as running by hand: tailscale serve --bg --https=8443 http://127.0.0.1:8790 (off: --https=8443 off).
      const config = loadConfig();
      const sub = rest[0] ?? "status";
      const dns = String(JSON.parse(tailscale(["status", "--json"])).Self?.DNSName ?? "").replace(/\.$/, "");
      const url = `https://${dns}${config.remotePort === 443 ? "" : `:${config.remotePort}`}`;
      if (sub === "on") {
        if (!config.remoteLogins.length) throw new Error('Add your Tailscale login first: "remoteLogins": ["you@example.com"] in ~/.switchboard/config.json');
        tailscale(["serve", "--bg", `--https=${config.remotePort}`, `http://127.0.0.1:${config.port}`]);
        return console.log(`On (tailnet only): ${url}\nAllowed: ${config.remoteLogins.join(", ")}`);
      }
      if (sub === "off") { tailscale(["serve", `--https=${config.remotePort}`, "off"]); return console.log("Off."); }
      const on = tailscale(["serve", "status"]).includes(`:${config.remotePort}`) || (config.remotePort === 443 && tailscale(["serve", "status"]).includes(`127.0.0.1:${config.port}`));
      return console.log(on ? `On (tailnet only): ${url}\nAllowed: ${config.remoteLogins.join(", ") || "nobody (set remoteLogins)"}` : `Off. Turn on: sb remote on`);
    }
    case "say": {
      await say(rest.join(" "));
      return console.log("sent");
    }
    default:
      console.log(HELP);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
