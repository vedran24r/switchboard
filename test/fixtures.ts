import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A fake home folder with Claude Code sessions in it (registry + transcripts) and a Switchboard config.
 * Nothing here touches the real ~/.claude: tests point HOME and SWITCHBOARD_STATE_DIR at this folder.
 * Every fake session uses this process's pid, so it counts as "alive" while the tests run.
 */

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const slug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

type Line = Record<string, unknown>;
const user = (text: string, at: number, uuid: string): Line => ({ type: "user", uuid, timestamp: iso(at), message: { role: "user", content: text } });
const reply = (text: string, at: number, uuid: string, tokens = 50_000): Line => ({
  type: "assistant", uuid, timestamp: iso(at),
  message: { model: "claude-test", content: [{ type: "text", text }], usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0 } },
});
const tool = (name: string, input: Record<string, unknown>, at: number, uuid: string, tokens = 50_000): Line => ({
  type: "assistant", uuid, timestamp: iso(at),
  message: { model: "claude-test", content: [{ type: "tool_use", id: `toolu_${uuid}`, name, input }], usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10 } },
});

/**
 * A small git repository with one change of each kind, for the Changes view: a.ts modified, gone.txt deleted, and two
 * untracked files (one with markup in it, one with a space in its path). Your global git hooks and signing are switched off.
 */
export function makeRepo(dir: string) {
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Sam", "-c", "user.email=sam@example.com",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main", ...args], { stdio: "ignore" });
  mkdirSync(path.join(dir, "sub dir"), { recursive: true });
  git("init", "-q");
  writeFileSync(path.join(dir, "a.ts"), "const a = 1;\nconst b = 2;\n");
  writeFileSync(path.join(dir, "gone.txt"), "bye\n");
  git("add", "."); git("commit", "-q", "-m", "start");
  writeFileSync(path.join(dir, "a.ts"), "const a = 1;\nconst b = 3;\n");
  rmSync(path.join(dir, "gone.txt"));
  writeFileSync(path.join(dir, "new.html"), `<script>window.__pwned = 1</script>\n<img src=x onerror="window.__pwned=1">\n`);
  writeFileSync(path.join(dir, "sub dir", "odd name.md"), "# ABC-12\n");
}

export function makeFixture(home: string) {
  const now = Date.now();
  const state = path.join(home, ".switchboard");
  const dispatcherDir = path.join(state, "dispatcher");
  mkdirSync(dispatcherDir, { recursive: true });

  const folders = {
    a: path.join(home, "Projects", "alpha"),
    b: path.join(home, "Projects", "beta"),
    client: path.join(home, "work", "client-x"),
    ticket: path.join(home, "work", "repo-ABC-12"),
    game: path.join(home, "GameProjects", "zomb"),
  };
  for (const dir of Object.values(folders)) mkdirSync(dir, { recursive: true });

  writeFileSync(path.join(state, "config.json"), JSON.stringify({
    blocked: ["~/work/client-*"],
    profiles: { "~/GameProjects": "game" },
    configDirs: { claude: "", game: "~/.claude-game" },
    sendProfiles: ["claude"],
    handoffTokens: 300_000,
    staleHours: 4,
    backend: "bg",
    pocketStateDir: "~/.no-pocket",
    domains: [
      { match: "~/work/client-*", domain: "client", icon: "🏥", color: "#0d9488" },
      { match: "~/GameProjects", domain: "game", icon: "🎮", color: "#16a34a" },
      { match: "~/Projects", domain: "tools", icon: "🛠️", color: "#ea580c" },
      { match: "~", domain: "home", icon: "🏠", color: "#a16207" },
    ],
    sessionStyles: { Beta: { icon: "🧪" } },
    uploadsDir: "~/uploads",
    uploadKeepDays: 7,
    vocabulary: "Switchboard, worktree, pilot, Mirza",
    corrections: { "work tree": "worktree", "meer za": "Mirza" },
  }));

  const sessions: { configDir: string; name: string; cwd: string; status: string; tmux?: string; updatedAt?: number; lines: Line[]; mtime?: number }[] = [
    // Compacted after its last reply: context must be the post-compact size, not 700k.
    { configDir: ".claude", name: "Compacted", cwd: folders.a, status: "idle", lines: [
      user("big job", now - 60_000, "c1"), reply("done with the big job", now - 50_000, "c2", 700_000),
      { type: "system", subtype: "compact_boundary", timestamp: iso(now - 40_000), compactMetadata: { preTokens: 700_000, postTokens: 12_000 } },
    ] },
    // Working, over the hand-off limit, latest step is a shell command.
    { configDir: ".claude", name: "Beta", cwd: folders.b, status: "busy", tmux: "pk-claude-beta:@1.%1", lines: [
      user("run the tests", now - 30_000, "b1"), tool("Bash", { command: "npm test\necho done" }, now - 20_000, "b2", 400_000),
    ] },
    // Waiting on a permission prompt.
    { configDir: ".claude", name: "Waiting", cwd: folders.a, status: "waiting", lines: [user("deploy?", now - 10_000, "w1"), reply("Can I run the deploy?", now - 9_000, "w2")] },
    // Auto-named, in a ticket folder: a run of tool calls, an answered AskUserQuestion, then an open one.
    { configDir: ".claude", name: "repo-abc-12-93", cwd: folders.ticket, status: "waiting", tmux: "pk-claude-repo-ABC-12:@9.%9", lines: [
      user("look at the ticket", now - 60_000, "k1"),
      tool("Bash", { command: `cd ${folders.ticket}; git log --oneline -5` }, now - 59_000, "k2"),
      tool("Bash", { command: `cd ${folders.ticket} && npm test`, description: "Run the unit tests" }, now - 58_000, "k3"),
      tool("Bash", { command: `cd ${folders.ticket}; cat ${folders.ticket}/src/a.ts` }, now - 57_000, "k4"),
      tool("mcp__claude_ai_Linear__get_issue", { id: "ABC-12" }, now - 56_000, "k5"),
      reply("The failures were duplicate numbers colliding after a merge.", now - 55_000, "k6"),
      tool("AskUserQuestion", { questions: [{ question: "Which branch?", header: "Branch", multiSelect: false, options: [{ label: "main", description: "the default" }, { label: "develop" }] }] }, now - 54_000, "k7"),
      { type: "user", uuid: "k8", timestamp: iso(now - 53_000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_k7", content: "User answered: main" }] },
        toolUseResult: { questions: [], answers: { "Which branch?": "main" } } },
      tool("Bash", { command: `cd ${folders.ticket}; git checkout main` }, now - 52_000, "k9"),
      user("<bash-input> ls src</bash-input>", now - 51_500, "k9a"),
      user("<bash-stdout>a.ts\nb.ts</bash-stdout><bash-stderr></bash-stderr>", now - 51_400, "k9b"),
      user("<command-name>/rename</command-name>\n            <command-message>rename</command-message>\n            <command-args>Ticket work</command-args>", now - 51_300, "k9c"),
      user("<local-command-stdout>\u001b[2mSession renamed\u001b[22m</local-command-stdout>", now - 51_200, "k9d"),
      tool("AskUserQuestion", { questions: [{ question: "Ship it now?", header: "Ship", multiSelect: false, options: [{ label: "Yes, ship" }, { label: "Wait for review" }] }] }, now - 51_000, "k10"),
    ] },
    // Idle for 10 hours: stale.
    { configDir: ".claude", name: "Old", cwd: folders.a, status: "idle", updatedAt: now - 10 * HOUR, mtime: now - 10 * HOUR, lines: [
      user("old question", now - 10 * HOUR, "o1"), reply("old answer", now - 10 * HOUR, "o2"),
    ] },
    // In a blocked (client) folder.
    { configDir: ".claude", name: "Client", cwd: folders.client, status: "idle", tmux: "pk-claude-client:@2.%2", lines: [reply("Should I deploy to the client?", now - 5_000, "x1")] },
    // On another profile (game), in tmux.
    { configDir: ".claude-game", name: "Zomb", cwd: folders.game, status: "idle", tmux: "pk-game-zomb:@3.%3", lines: [reply("**Inventory** is [full](https://x.y)", now - 4_000, "z1")] },
    // The dispatcher: chat lines + one route of each kind; plenty of lines for scroll tests.
    { configDir: ".claude", name: "Switchboard", cwd: dispatcherDir, status: "idle", lines: [
      ...Array.from({ length: 30 }, (_, i) => [user(`question ${i}`, now - 300_000 + i * 2000, `q${i}`), reply(`answer ${i}\n` + "line\n".repeat(4), now - 299_000 + i * 2000, `a${i}`)]).flat(),
      tool("SendMessage", { to: "Beta [3fa9c1]", message: "please run the tests" }, now - 30_000, "r1"),
      tool("Bash", { command: `sb spawn --cwd ~/Projects/alpha --name "New one" --group m-1 "Look at the logs"` }, now - 29_000, "r2"),
      tool("Bash", { command: `sb send "Zomb" "check the inventory"` }, now - 28_000, "r3"),
      tool("SendMessage", { to: "Beta", notify_when_idle: true }, now - 27_000, "r4"), // subscription only: not a route
      user('<cross-session-message from="uds:/x" from-name="Beta" from-mode="p">\nTests pass on **beta**.\n</cross-session-message>', now - 26_000, "n1"),
      reply("→ Beta: tests pass, nothing else to do.", now - 25_000, "n2"),
    ] },
  ];

  for (const s of sessions) {
    const configDir = path.join(home, s.configDir);
    const sessionId = `${s.name.toLowerCase()}-0000-0000`;
    mkdirSync(path.join(configDir, "sessions"), { recursive: true });
    mkdirSync(path.join(configDir, "projects", slug(s.cwd)), { recursive: true });
    const transcript = path.join(configDir, "projects", slug(s.cwd), `${sessionId}.jsonl`);
    writeFileSync(transcript, s.lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    if (s.mtime) utimesSync(transcript, s.mtime / 1000, s.mtime / 1000);
    const updatedAt = s.updatedAt ?? now - 1000;
    writeFileSync(path.join(configDir, "sessions", `${s.name}.json`), JSON.stringify({
      pid: process.pid, sessionId, cwd: s.cwd, kind: "interactive", name: s.name, status: s.status, tmux: s.tmux, updatedAt, statusUpdatedAt: updatedAt,
    }));
  }
  return { home, state, folders };
}
