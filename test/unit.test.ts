import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { makeFixture } from "./fixtures.ts";

// Point everything at a fake home BEFORE loading Switchboard (it reads HOME at import time).
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-unit-")));
const fx = makeFixture(home);
process.env.HOME = home;
process.env.SWITCHBOARD_STATE_DIR = fx.state;
// Never touch the real `tmux -L switchboard`: the whole suite uses its own tmux server, removed at the end.
const TEST_SOCKET = `sb-test-${process.pid}`;
process.env.SWITCHBOARD_TMUX_SOCKET = TEST_SOCKET;
const { listSessions } = await import("../src/sessions.ts");
const { dispatcherFeed, sendByName, sessionChat } = await import("../src/dispatcher.ts");
const { spawnSession } = await import("../src/spawn.ts");
const { isBlocked, profileFor, styleFor, loadConfig } = await import("../src/config.ts");
const { askFromText, askFromScreen, waitingOnYou, askFromQuestion } = await import("../src/asks.ts");
const { pressKey, sayTo, toolRow, noticeLine, replySession, cleanCommand } = await import("../src/dispatcher.ts");
const { saveUpload, uploadFile, pruneUploads, uploadDir } = await import("../src/uploads.ts");
const { rerunLanguage, applyCorrections, toLatin } = await import("../src/voice.ts");
const { existsSync, writeFileSync, utimesSync, mkdirSync } = await import("node:fs");

const config = loadConfig();
const byName = Object.fromEntries(listSessions(config).map((s) => [s.name, s]));

test("finds every live session across profiles", () => {
  assert.deepEqual(Object.keys(byName).sort(), ["Beta", "Client", "Compacted", "Old", "Switchboard", "Waiting", "Zomb", "repo-abc-12-93"]);
  assert.equal(byName.Zomb.profile, "game");
});

test("one row per sessionId when the registry lists a session twice", async () => {
  const { rmSync } = await import("node:fs");
  const dup = `${home}/.claude/sessions/Beta-old.json`;
  writeFileSync(dup, JSON.stringify({ pid: process.pid, sessionId: "beta-0000-0000", cwd: fx.folders.b, kind: "interactive", name: "Beta old", updatedAt: Date.now() - 3_600_000 }));
  try {
    const rows = listSessions(config).filter((s) => s.sessionId === "beta-0000-0000");
    assert.deepEqual(rows.map((s) => s.name), ["Beta"]);
  } finally {
    rmSync(dup);
  }
});

test("a handoff note written since the last prompt replaces the hand-off flag", async () => {
  const { readFileSync } = await import("node:fs");
  const file = byName.Beta.transcript, before = readFileSync(file, "utf8");
  const note = `${home}/.switchboard/handoffs/beta-20261030.md`;
  const write = { type: "assistant", uuid: "h1", timestamp: new Date().toISOString(),
    message: { model: "claude-test", content: [{ type: "tool_use", id: "toolu_h1", name: "Write", input: { file_path: note, content: "x" } }], usage: { input_tokens: 10, cache_read_input_tokens: 400_000 } } };
  writeFileSync(file, before + JSON.stringify(write) + "\n");
  try {
    const beta = listSessions(config).find((s) => s.name === "Beta")!;
    assert.equal(beta.handoffNote, note);
    assert.equal(beta.needsHandoff, false);
  } finally {
    writeFileSync(file, before);
  }
});

test("context after /compact is the post-compact size", () => {
  assert.equal(byName.Compacted.contextTokens, 12_000);
  assert.equal(byName.Compacted.needsHandoff, false);
});

test("hand-off flag over the limit", () => {
  assert.equal(byName.Beta.contextTokens, 400_000);
  assert.equal(byName.Beta.needsHandoff, true);
});

test("states: working / needs-you / idle / stale", () => {
  assert.equal(byName.Beta.state, "working");
  assert.equal(byName.Waiting.state, "needs-you");
  assert.equal(byName.Compacted.state, "idle");
  assert.equal(byName.Old.state, "stale");
});

test("speech-bubble line: latest tool while working, first reply line otherwise (no markdown)", () => {
  assert.equal(byName.Beta.doing, "$ npm test");
  assert.equal(byName.Zomb.doing, "Inventory is full");
  assert.ok(byName.Zomb.lastReplyAt && byName.Zomb.lastReplyAt > Date.now() - 60_000);
});

test("look: area by folder, per-session override", () => {
  assert.equal(byName.Client.domain, "client");
  assert.equal(byName.Zomb.icon, "🎮");
  assert.equal(byName.Beta.icon, "🧪");
  assert.equal(styleFor("x", home, config).domain, "home");
});

test("blocked folders and profiles from config", () => {
  assert.ok(isBlocked(fx.folders.client, config));
  assert.equal(isBlocked(fx.folders.a, config), undefined);
  assert.equal(profileFor(fx.folders.game, config), "game");
  assert.equal(profileFor(fx.folders.a, config), "claude");
});

test("dispatcher feed: chat lines and routes (SendMessage, sb spawn, sb send; not subscriptions)", () => {
  const feed = dispatcherFeed(config);
  assert.equal(feed.running, true);
  assert.ok(feed.chat.some((c) => c.role === "you" && c.text === "question 0"));
  assert.deepEqual(feed.routes.map((r) => [r.kind, r.target]), [["send", "Beta"], ["spawn", "New one"], ["send", "Zomb"]]);
  const ids = feed.chat.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "chat ids are unique");
  assert.deepEqual(dispatcherFeed(config).chat.map((c) => c.id), ids, "chat ids are stable between reads");
});

test("session chat for popups", () => {
  const d = sessionChat(byName.Beta.sessionId, config);
  assert.equal(d.canType, true);
  assert.equal(d.chat[0].text, "run the tests");
  assert.equal(sessionChat("nope", config).gone, true);
});

test("sb send guards", async () => {
  await assert.rejects(sendByName("Client", "hi", config), /BLOCKED/);
  await assert.rejects(sendByName("Zomb", "hi", config), /NOT ALLOWED: profile "game"/);
  await assert.rejects(sendByName("Nobody", "hi", config), /No live session called/);
  await assert.rejects(sendByName("Compacted", "hi", config), /doesn't run in tmux/);
  await assert.rejects(sendByName("Beta", "  ", config), /usage/);
});

test("sb spawn guards (refuse before starting anything)", async () => {
  await assert.rejects(spawnSession({ cwd: fx.folders.client, name: "x", prompt: "p" }, config), /BLOCKED/);
  await assert.rejects(spawnSession({ cwd: path.join(home, "missing"), name: "x", prompt: "p" }, config), /doesn't exist/);
  await assert.rejects(spawnSession({ cwd: fx.folders.a, name: "Beta", prompt: "p" }, config), /already called "Beta"/);
  await assert.rejects(spawnSession({ cwd: "/tmp", name: "x", prompt: "p" }, config), /inside/);
});

test("uploads: saved with our name pattern, other types refused, only our own old files pruned", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const file = saveUpload(png, "image/png", config);
  assert.match(path.basename(file), /^switchboard-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
  assert.equal(path.dirname(file), path.join(home, "uploads", "switchboard"));
  assert.equal(uploadFile(path.basename(file), config), file);
  assert.equal(uploadFile("../../etc/passwd", config), undefined);
  assert.equal(uploadFile("phone-1.png", config), undefined);
  assert.throws(() => saveUpload(png, "image/bmp", config), /Only PNG/);
  assert.throws(() => saveUpload(Buffer.alloc(0), "image/png", config), /Empty/);
  const old = saveUpload(png, "image/png", config), foreign = path.join(uploadDir(config), "notes.txt");
  writeFileSync(foreign, "keep me");
  const longAgo = (Date.now() - 30 * 86_400_000) / 1000;
  utimesSync(old, longAgo, longAgo); utimesSync(foreign, longAgo, longAgo);
  const removed = pruneUploads(config);
  assert.deepEqual(removed, [path.basename(old)]);
  assert.ok(existsSync(file) && existsSync(foreign) && !existsSync(old));
});

test("asks: reading questions and choices from a message", () => {
  assert.deepEqual(askFromText('Found the cause. Reply "2" to file the ticket, or "1" to just fix it.')?.options.map((o) => o.send), ["2", "1"]);
  assert.deepEqual(askFromText("Which one?\n1. Rebuild local now\n2. Skip the rebuild\n3. Ask Sam")?.options.map((o) => o.label), ["1. Rebuild local now", "2. Skip the rebuild", "3. Ask Sam"]);
  assert.deepEqual(askFromText("Should I rebuild the local stack?")?.options.map((o) => o.send), ["yes", "no"]);
  assert.equal(askFromText("Done. All tests pass."), undefined);
  assert.equal(askFromText("Steps I took:\n1. Read the logs\n2. Fixed it\nAll good now."), undefined, "a numbered list that isn't a question");
});

test("asks: answers that make sense (real shapes: either/or, numbered questions, suggested replies)", () => {
  const sends = (t: string) => askFromText(t)?.options.map((o) => o.send);
  // A numbered list of questions is something to answer, not a menu; the real question is the either/or at the end.
  const checklist = "Logged it.\n\n- **Checklist:**\n  1. Can a personal tailnet run on it? Probably not.\n  2. Will the EDR allow launchd services?\n  3. Is Homebrew allowed?\n\nThe edit isn't committed. Want it committed, or left as a working note?";
  assert.deepEqual(sends(checklist), ["Committed", "Left as a working note"]);
  assert.deepEqual(askFromText("**Next:** I'd build a skill plus a hook. Want that, or should I start with the smaller, easier-to-measure CLAUDE.md trim?")?.options.map((o) => o.label),
    ["Yes, do that", "Start with the smaller, easier-to-measure…"]);
  // "Here's a reply you could post" is not an answer called "you"; the question just above it still counts.
  assert.deepEqual(sends("It's about 3 lines. Want me to make it?\n\nHere's a reply you could post under Sam's message:\n\n> yep, one-off."), ["yes", "no"]);
  // Several open questions: no buttons that just repeat them, a note instead.
  const several = askFromText("Before I install anything, please confirm:\n1. Is Tailscale allowed?\n2. Are launchd agents allowed?\n3. Which account?")!;
  assert.deepEqual([several.options, several.note], [[], "It asked 3 questions: answer them in the reply box."]);
  assert.deepEqual(several.fill, ["1. Is Tailscale allowed?", "2. Are launchd agents allowed?", "3. Which account?"]);
  // Fill-in questions without a "?" (a real shape, names swapped): a numbered block under "Numbers to fill in", followed by
  // a "Your call" list. Each item is answered in its own words, never offered as a button that sends its number.
  const fillIn = askFromText("Everything else is ready to paste.\n\n**Numbers to fill in (`[?]`):**\n1. How many QA people Acme has, and how many attend the guild (KR2.1).\n2. How many installs so far (KR1.2).\n3. How many Acme projects exist, for the audit in KR2.4. \"Month 1\" works if you don't know.\n4. Does auto-QA per PR already run anywhere besides ABC-12? If so, change the baseline.\n\n**Your call:**\n- **4 objectives may be too many.** Fold O4 into O3 if your manager wants 3.\n- **KR4.4 is my suggestion.** Drop it if it doesn't fit.")!;
  assert.deepEqual([fillIn.options, fillIn.fill?.length, fillIn.fill?.[1]], [[], 4, "2. How many installs so far (KR1.2)."]);
  assert.deepEqual(sends("Should I wait 10 minutes or so?"), ["yes", "no"], "'or so' isn't a choice");
  assert.deepEqual(sends("Should I keep it or not?"), ["yes", "no"]);
  assert.deepEqual(sends("Rebase onto main, or merge main in?"), ["Rebase onto main", "Merge main in"]);
  const findings = "Where the money goes:\n1. **Long sessions: ~$200.** Every token is re-sent.\n2. **Subagents on Opus: ~$70.** Most run on Opus.\n3. Smaller wins: line ranges.\n\n**Corrections:** the 36% is really 14%.\n\n**Next:** I'd build a skill plus a hook. Want that, or should I start with the CLAUDE.md trim?";
  assert.deepEqual(sends(findings), ["Yes, do that.", "Start with the CLAUDE.md trim"], "a list of findings isn't a menu");
  assert.deepEqual(sends("I can do it two ways:\n1. Patch the helper\n2. Rewrite the poller\nWhich one?"), ["1", "2"], "numbers named right after");
});

test("asks: Claude Code's permission dialog on screen → number keys", () => {
  const screen = " Bash command\n   docker compose up -d --build\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for docker commands\n   3. No, and tell Claude what to do differently (esc)\n";
  const ask = askFromScreen(screen)!;
  assert.equal(ask.kind, "permission");
  assert.deepEqual(ask.options.map((o) => o.key), ["1", "2", "3"]);
  assert.equal(askFromScreen("just some output\n1. item"), undefined);
});

test("asks on sessions: waiting / asking ones get options, blocked folders flagged, dispatcher never", () => {
  assert.deepEqual(byName.Waiting.ask?.options.map((o) => o.send), ["yes", "no"]);
  assert.equal(byName.Waiting.askBlocked, false);
  assert.ok(byName.Client.ask && byName.Client.askBlocked === true);
  assert.equal(byName.Compacted.ask, undefined);
  assert.equal(byName.Beta.ask, undefined, "working sessions aren't asking");
  assert.equal(byName.Switchboard.ask, undefined, "never for the dispatcher");
});

test("quick-reply guards: blocked folders, dispatcher, unknown keys", async () => {
  await assert.rejects(sayTo(byName.Client.sessionId, "yes", config, { quick: true }), /Quick replies are off/);
  await assert.rejects(pressKey(byName.Client.sessionId, "1", config), /Quick replies are off/);
  await assert.rejects(pressKey(byName.Switchboard.sessionId, "1", config), /Not for Switchboard/);
  await assert.rejects(sayTo(byName.Switchboard.sessionId, "yes", config), /main chat/);
  await assert.rejects(pressKey(byName.Beta.sessionId, "rm -rf", config), /unknown key/);
  await assert.rejects(pressKey(byName.Waiting.sessionId, "1", config), /doesn't run in tmux/);
});

test("voice language: only English or Bosnian (BCMS); anything else is transcribed again", () => {
  assert.equal(rerunLanguage("english", { en: 0.98 }, "check the tests"), undefined);
  assert.equal(rerunLanguage("croatian", { hr: 0.9, bs: 0.05 }, "pitaj ga"), undefined);
  assert.equal(rerunLanguage("bosnian", { bs: 0.9 }, "pitaj ga"), undefined);
  assert.equal(rerunLanguage("russian", { ru: 0.6, sr: 0.2, bs: 0.1, en: 0.05 }, "Пиши"), "bs", "BCMS likelier than English → Bosnian");
  assert.equal(rerunLanguage("bulgarian", { bg: 0.7, en: 0.2, hr: 0.05 }, "x"), "en", "English likelier → English");
  assert.equal(rerunLanguage("russian", { ru: 0.999 }, "x"), "en", "no hint at all → English");
  assert.equal(rerunLanguage("serbian", { sr: 0.9 }, "Питај га"), "bs", "Serbian in Cyrillic → again in Latin");
  assert.equal(rerunLanguage("serbian", { sr: 0.9 }, "Pitaj ga"), undefined);
  assert.equal(toLatin("Питај Мирзу да ли је пилот спреман, Џеко."), "Pitaj Mirzu da li je pilot spreman, Džeko.");
  assert.equal(toLatin("check ABC-12 ok"), "check ABC-12 ok");
});

test("voice corrections: heard → meant, whole words, any case, longest first", () => {
  const fix = { "meer za": "Mirza", "meer za smith": "Mirzet", "pull": "PR" };
  assert.equal(applyCorrections("Ask Meer  Za about it", fix), "Ask Mirza about it");
  assert.equal(applyCorrections("ask meer za smith now", fix), "ask Mirzet now");
  assert.equal(applyCorrections("pull 123, but not pulled", fix), "PR 123, but not pulled");
  assert.equal(applyCorrections("unchanged", {}), "unchanged");
  assert.deepEqual(loadConfig().corrections, { "work tree": "worktree", "meer za": "Mirza" });
});

test("chat: tool calls become quiet rows, notices and replies know their session", () => {
  assert.deepEqual(toolRow("Bash", { command: "sb ls\necho" }), { name: "Bash", icon: "🔧", label: "$ sb ls", detail: "sb ls\necho" });
  assert.equal(toolRow("Bash", { command: `sb send "Zomb" "check it"` }).session, "Zomb");
  assert.equal(toolRow("SendMessage", { to: "Beta [3fa9c1]", message: "hi" }).label, "Message to Beta");
  assert.equal(toolRow("Read", { file_path: "/a/b/c.ts" }).label, "Read b/c.ts");
  assert.equal(toolRow("mcp__claude_ai_Linear__get_issue", { id: 1 }).label, "get_issue");
  assert.deepEqual(noticeLine('[Cross-session idle notice] "Misc", which you asked to be notified about, is idle now — it finished a turn at 19:15. Its harness reports: «Permission to rebuild». This is an automated notice.'),
    { session: "Misc", text: "Finished at 19:15: Permission to rebuild" });
  assert.equal(replySession("＋ KSP mod research (~/Projects/ksp) started"), "KSP mod research");
  assert.equal(replySession("→ Misc: asked it"), "Misc");
  assert.equal(replySession("All done."), undefined);
  const chat = dispatcherFeed(config).chat;
  assert.ok(chat.some((c) => c.role === "tool" && c.session === "Zomb" && c.tool?.icon === "💬"), "sb send row");
  assert.ok(chat.some((c) => c.role === "notice" && c.session === "Beta" && c.text.includes("Tests pass")), "notice from Beta");
  assert.ok(chat.some((c) => c.role === "switchboard" && c.session === "Beta"), "→ Beta reply");
});

// Three real "waiting on you" replies that showed no "?" (names and links swapped for placeholders).
const BACKLOG_PICK = `Both tickets are fixed on pilot, but I haven't moved them yet. You asked that I check with you directly before any status change, and a relayed request doesn't count.

**Move [ABC-1571](https://example.com/ABC-1571) and [ABC-1381](https://example.com/ABC-1381) from Backlog to Done?** It's a status change only: no comments and no other edits.

- **ABC-1571:** Swagger now marks two fields as nullable.
- **ABC-1381:** the test skips when its data is missing.`;
const BACKLOG_PICK_PROPOSED = "Both tickets are fixed on pilot, but I haven't moved them yet. You asked that I check with you directly before any ticket status change.\n\nProposed: ABC-1571 Backlog -> Done and ABC-1381 Backlog -> Done.";
const MISC = "The PR is open and the stack is back on the nightly build.\n\n**Decision for you:** should I drop `[UNVERIFIED]` from the ABC-1593 title? The bug reproduced on local.\n\n- **Not run:** the Playwright specs.\n- **Footer:** changing the commit means a force-push, so I left it. Say if you want it gone.";
const MISC_EARLIER = "The fix is ready in its worktree. I still need your own yes here before I touch the local stack: rebuilding it stops the other session's run.";
const PS_TOKENS = "I haven't created the ticket yet.\n\nThe Switchboard session says you approved option 2, but a decision passed along from another session isn't one I can treat as your sign-off. Reply **2** here and I'll file it straight away: QA project, In Progress, Low priority.";

test("asks: waiting on you without a final question (real examples)", () => {
  const sends = (t) => askFromText(t)?.options.map((o) => o.send);
  assert.deepEqual(sends(BACKLOG_PICK), ["yes", "no"], "Backlog pick: bold question mid-reply");
  assert.deepEqual(sends(BACKLOG_PICK_PROPOSED), ["yes", "no"], "Backlog pick: haven't moved them yet + Proposed:");
  assert.deepEqual(sends(MISC), ["yes", "no"], "Misc: Decision for you");
  assert.deepEqual(sends(MISC_EARLIER), ["yes", "no"], "Misc: I still need your own yes");
  assert.deepEqual(sends(PS_TOKENS), ["2"], "PS Tokens: Reply **2** here");
  assert.deepEqual(sends("Permission to Rebuild Local"), ["yes", "no"]);
  assert.deepEqual(sends("Done. Waiting for your go before I push."), ["yes", "no"]);
});

test("asks: reports that only mention approvals stay quiet", () => {
  assert.equal(waitingOnYou("PR is open. Tickets: untouched; I didn't comment on or move any. CI: I'll report when the checks finish."), false);
  assert.equal(waitingOnYou("I haven't pushed the docs yet; they go out with the next release."), false, "not-yet alone");
  assert.equal(waitingOnYou("This change doesn't need your approval, it's local only."), false);
  assert.equal(askFromText("You asked me to wait for approvals on tickets. All three are now Done, as you said."), undefined);
  assert.equal(askFromText("Fixed it. **Tests:** all green."), undefined);
});

test("access: this Mac, or an allowed Tailscale login through tailscale serve", async () => {
  const { checkAccess, sameOrigin } = await import("../src/access.ts");
  const req = (host: string, headers: Record<string, string> = {}, ip = "127.0.0.1") => ({ headers: { host, ...headers }, socket: { remoteAddress: ip } }) as any;
  const logins = ["me@example.com"];
  const ts = "mac.tail123.ts.net:8443";
  assert.deepEqual(checkAccess(req("127.0.0.1:8790"), 8790, []), { ok: true, remote: false, origin: "http://127.0.0.1:8790" });
  assert.equal(checkAccess(req("evil.example:8790"), 8790, logins).ok, false); // DNS rebinding
  assert.deepEqual(checkAccess(req("127.0.0.1:9000"), 8790, []), { ok: true, remote: false, origin: "http://127.0.0.1:9000" }); // ssh -L 9000:127.0.0.1:8790
  assert.equal(checkAccess(req("localhost:9000"), 8790, []).ok, true);
  assert.equal(checkAccess(req("127.0.0.1.evil.example:8790"), 8790, []).ok, false);
  assert.equal(checkAccess(req("127.0.0.1:8790", {}, "100.1.2.3"), 8790, logins).ok, false); // not via loopback
  assert.equal(checkAccess(req(ts), 8790, logins).ok, false); // no Tailscale identity (funnel or forged host)
  assert.equal(checkAccess(req(ts, { "tailscale-user-login": "other@example.com" }), 8790, logins).ok, false);
  assert.equal(checkAccess(req(ts, { "tailscale-user-login": "me@example.com" }), 8790, []).ok, false); // nobody allowed by default
  assert.equal(checkAccess(req(ts, { "tailscale-user-login": "Me@Example.com" }, "100.1.2.3"), 8790, logins).ok, false);
  const ok = checkAccess(req(ts, { "tailscale-user-login": "Me@Example.com" }), 8790, logins);
  assert.deepEqual(ok, { ok: true, remote: true, origin: "https://mac.tail123.ts.net:8443", login: "me@example.com" });
  if (!ok.ok) return;
  assert.equal(sameOrigin({ headers: { origin: "https://mac.tail123.ts.net:8443" } } as any, ok), true);
  assert.equal(sameOrigin({ headers: { origin: "http://127.0.0.1:8790" } } as any, ok), false);
  assert.equal(sameOrigin({ headers: { origin: "https://evil.example" } } as any, ok), false);
  assert.equal(checkAccess(req("mac.tail123.ts.net", { "tailscale-user-login": "me@example.com" }), 8790, logins).ok && true, true);
});

test("typeOnce: a retry with the same id after a lost response types nothing twice; a failed try can be retried", async () => {
  const { typeOnce } = await import("../src/server.ts");
  let typedCount = 0;
  const type = async () => { typedCount++; };
  assert.deepEqual(await typeOnce("msg-abc123", type), { ok: true });
  assert.deepEqual(await typeOnce("msg-abc123", type), { ok: true, duplicate: true });
  assert.equal(typedCount, 1);
  await assert.rejects(typeOnce("msg-fail01", async () => { throw new Error("dispatcher not running"); }));
  assert.deepEqual(await typeOnce("msg-fail01", type), { ok: true }, "failed first try isn't remembered");
  await typeOnce(undefined, type); await typeOnce(undefined, type);
  assert.equal(typedCount, 4, "no id (curl, sb say): always typed");
});

test("tool rows: Bash labels show the real command (no cd prefix, folder as .), or the call's description", () => {
  const cwd = `${home}/work/repo-ABC-12`;
  assert.equal(cleanCommand(`cd ${cwd}; git log --oneline -5`, cwd), "git log --oneline -5");
  assert.equal(cleanCommand(`cd ${cwd} && cd web && npm test`, cwd), "npm test");
  assert.equal(cleanCommand(`cd "${cwd}" && cat ${cwd}/src/a.ts`, cwd), "cat src/a.ts");
  assert.equal(cleanCommand(`ls ${home}/Projects`, ""), "ls ~/Projects");
  assert.equal(toolRow("Bash", { command: `cd ${cwd}; npm test`, description: "Run the unit tests" }, cwd).label, "Run the unit tests");
  assert.equal(toolRow("Bash", { command: `cd ${cwd}; npm test` }, cwd).label, "$ npm test");
});

test("display names: automatic names show the ticket or folder; given names stay", async () => {
  const { displayName } = await import("../src/sessions.ts");
  assert.equal(displayName("repo-abc-12-93", "/x/repo-ABC-12", true), "ABC-12");
  assert.equal(displayName("repo-ABC-12", "/x/repo-ABC-12", false), "ABC-12");
  assert.equal(displayName("client-notes-57", "/x/client-notes", true), "client-notes");
  assert.equal(displayName("repo-abc-15-7d", "/x/repo-ABC-15", true), "ABC-15", "hex suffix");
  assert.equal(displayName("Misc", "/x/repo", true), "Misc");
  assert.equal(displayName("repo", "/x/repo", false), "repo");
});

test("AskUserQuestion: a card in the chat with its answer; waiting on you while open (number keys)", () => {
  const one = askFromQuestion({ questions: [{ question: "Which fix?", header: "Fix", multiSelect: false, options: [{ label: "Patch it" }, { label: "Rewrite it", description: "bigger" }] }] })!;
  assert.deepEqual(one, { kind: "permission", picker: true, question: "Which fix?", options: [{ label: "1. Patch it", key: "1" }, { label: "2. Rewrite it", key: "2" }],
    questions: [{ question: "Which fix?", header: "Fix", options: [{ label: "Patch it" }, { label: "Rewrite it", description: "bigger" }] }] });
  const many = askFromQuestion({ questions: [{ question: "A?", options: [] }, { question: "B?", multiSelect: true, options: [{ label: "x" }] }] })!;
  assert.deepEqual([many.options, /2 questions/.test(many.note!), many.questions], [[], true, [{ question: "A?", options: [] }, { question: "B?", multiSelect: true, options: [{ label: "x" }] }]]);
  const s = byName["repo-abc-12-93"];
  assert.equal(s.display, "ABC-12");
  const chat = sessionChat(s.sessionId).chat;
  const cards = chat.filter((c) => c.role === "ask");
  assert.equal(cards.length, 2, "two AskUserQuestion cards");
  assert.deepEqual(cards[0].answers, { "Which branch?": "main" }, "answered one has its answer");
  assert.equal(cards[1].answers, undefined, "open one has none");
  assert.ok(!chat.some((c) => c.role === "tool" && c.tool?.name === "AskUserQuestion"), "no tool row for it");
  assert.deepEqual(s.ask?.options.map((o) => o.key), ["1", "2"], "open question → number keys");
  assert.equal(s.ask?.question, "Ship it now?");
});

test("typing into Pocket sessions: names Pocket's API rejects (uppercase) go straight to tmux; ended sessions say so", async () => {
  const { createServer } = await import("node:http");
  const { chmodSync, readFileSync: read } = await import("node:fs");
  const sent: string[] = [];
  // A fake Pocket with the real one's name rule.
  const pocket = createServer((req, res) => {
    const name = decodeURIComponent(req.url!.split("/")[3] ?? "");
    if (req.url === "/api/launch-options") return res.end("{}");
    if (!/^(pk|ro)-[a-z0-9._-]+$/.test(name)) { res.statusCode = 400; return res.end(JSON.stringify({ error: "bad session" })); }
    sent.push(name); res.end("{}");
  });
  await new Promise<void>((r) => pocket.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(os.tmpdir(), "sb-pk-"));
  writeFileSync(path.join(dir, "access-key"), "k");
  // A fake tmux that logs its arguments.
  const bin = path.join(dir, "bin"); mkdirSync(bin);
  const log = path.join(dir, "tmux.log");
  writeFileSync(path.join(bin, "tmux"), `#!/bin/sh\necho "$@" >> ${log}\n`); chmodSync(path.join(bin, "tmux"), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  const cfg = { ...config, pocketUrl: `http://127.0.0.1:${(pocket.address() as any).port}`, pocketStateDir: dir, backend: "auto" as const };
  try {
    await sayTo(byName.Beta.sessionId, "lowercase goes via Pocket", cfg);
    assert.deepEqual(sent, ["pk-claude-beta"]);
    await sayTo(byName["repo-abc-12-93"].sessionId, "both 1", cfg);
    const typed = read(log, "utf8");
    assert.match(typed, /-L pocket send-keys -t =pk-claude-repo-ABC-12: -l -- both 1/, "typed into Pocket's tmux");
    assert.match(typed, /send-keys -t =pk-claude-repo-ABC-12: Enter/);
    assert.deepEqual(sent, ["pk-claude-beta"], "Pocket's API never got the uppercase name");
    await pressKey(byName["repo-abc-12-93"].sessionId, "1", cfg);
    assert.match(read(log, "utf8"), /send-keys -t =pk-claude-repo-ABC-12: -l 1/);
    await assert.rejects(sayTo("no-such-session", "hi", cfg), (e: any) => e.gone === true && /isn't running any more/.test(e.message));
  } finally { process.env.PATH = oldPath; pocket.close(); }
});

test("quick keys: page names → tmux key names; nothing else is a key", async () => {
  const { tmuxKeyArgs } = await import("../src/dispatcher.ts");
  const map = Object.fromEntries(["esc", "enter", "up", "down", "left", "right", "space", "tab", "stab", "ctrlc", "1", "5", "9", "y"].map((k) => [k, tmuxKeyArgs(k)]));
  assert.deepEqual(map, { esc: ["Escape"], enter: ["Enter"], up: ["Up"], down: ["Down"], left: ["Left"], right: ["Right"], space: ["Space"], tab: ["Tab"], stab: ["BTab"], ctrlc: ["C-c"],
    1: ["-l", "1"], 5: ["-l", "5"], 9: ["-l", "9"], y: ["-l", "y"] });
  for (const bad of ["C-c", "Escape", "constructor", "toString", "__proto__", "rm -rf", "", "10", "a"]) assert.throws(() => tmuxKeyArgs(bad), /unknown key/, bad);
});

/** A fake tmux on PATH that logs its arguments; capture-pane answers for pk-claude-beta only. Never the real server. */
async function withFakeTmux(fn: (log: () => string) => Promise<void>) {
  const { chmodSync, readFileSync: read } = await import("node:fs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sb-tmux-")), bin = path.join(dir, "bin"), log = path.join(dir, "tmux.log");
  mkdirSync(bin); writeFileSync(log, "");
  writeFileSync(path.join(bin, "tmux"), `#!/bin/sh\necho "$@" >> ${log}\ncase "$*" in\n  *capture-pane*=pk-claude-beta:*) printf '\\033[1;31mred\\033[0m <b>&amp;\\n\\n\\n' ;;\n  *capture-pane*) exit 1 ;;\nesac\n`);
  chmodSync(path.join(bin, "tmux"), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  try { await fn(() => read(log, "utf8")); } finally { process.env.PATH = oldPath; }
}

test("quick keys: pressed in the session's own tmux; guards kept (blocked, dispatcher, not in tmux, unknown)", async () => {
  await withFakeTmux(async (log) => {
    // The fixture's backend is "bg" (no Pocket), so every key goes straight to tmux -L pocket for pk-* sessions.
    for (const k of ["up", "down", "left", "right", "space", "tab", "stab", "ctrlc", "esc", "enter", "3", "7"]) await pressKey(byName.Beta.sessionId, k, config);
    const lines = log().trim().split("\n");
    assert.deepEqual(lines, ["Up", "Down", "Left", "Right", "Space", "Tab", "BTab", "C-c", "Escape", "Enter", "-l 3", "-l 7"].map((k) => `-L pocket send-keys -t =pk-claude-beta: ${k}`));
    await assert.rejects(pressKey(byName.Client.sessionId, "ctrlc", config), /Quick replies are off/);
    await assert.rejects(pressKey(byName.Switchboard.sessionId, "esc", config), /Not for Switchboard/);
    await assert.rejects(pressKey(byName.Waiting.sessionId, "stab", config), /doesn't run in tmux/);
    await assert.rejects(pressKey(byName.Beta.sessionId, "C-c", config), /unknown key/);
    await assert.rejects(pressKey("no-such-session", "esc", config), (e: any) => e.gone === true);
    assert.equal(log().trim().split("\n").length, lines.length, "no refused key reached tmux");
  });
});

test("terminal view: capture-pane -e of the session's pane; refused for blocked folders without touching tmux", async () => {
  const { sessionScreen } = await import("../src/dispatcher.ts");
  await withFakeTmux(async (log) => {
    assert.deepEqual(sessionScreen(byName.Beta.sessionId, config), { screen: "\x1b[1;31mred\x1b[0m <b>&amp;" }, "colours kept, trailing blank lines trimmed");
    assert.match(log(), /^-L pocket capture-pane -e -p -t =pk-claude-beta:$/m);
    assert.throws(() => sessionScreen(byName.Client.sessionId, config), (e: any) => e.status === 403 && e.blocked === true && /off for this folder \(blocked\)/.test(e.message));
    assert.throws(() => sessionScreen(byName.Switchboard.sessionId, config), (e: any) => e.status === 403);
    assert.throws(() => sessionScreen(byName.Waiting.sessionId, config), (e: any) => e.status === 409 && /doesn't run in tmux/.test(e.message));
    assert.throws(() => sessionScreen(byName.Zomb.sessionId, config), (e: any) => e.gone === true, "pane gone");
    assert.throws(() => sessionScreen("no-such-session", config), (e: any) => e.gone === true);
    assert.doesNotMatch(log(), /client/, "the blocked session's pane was never captured");
  });
});

test("shell commands and /commands you typed show as your own lines, with their output", () => {
  const chat = sessionChat(byName["repo-abc-12-93"].sessionId).chat.filter((c) => c.role === "shell");
  assert.deepEqual(chat.map((c) => [c.text, c.output]), [["! ls src", "a.ts\nb.ts"], ["/rename Ticket work", "Session renamed"]]);
});

test("a message typed while the session was busy (taken in mid-turn) shows as your own line, once; task notifications don't", async () => {
  const { readChat } = await import("../src/dispatcher.ts");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sb-queued-")), file = path.join(dir, "t.jsonl"), t0 = Date.parse("2026-11-02T15:02:00Z");
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const attach = (uuid: string, s: number, prompt: string, kind = "human") => ({ type: "attachment", uuid, timestamp: at(s),
    attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind }, humanTurn: kind === "human" } });
  const text = "also the input is cut off at the bottom\n[image: /tmp/x.png]";
  writeFileSync(file, [
    { type: "user", uuid: "u1", timestamp: at(0), message: { role: "user", content: "fix the picker for Sam" } },
    { type: "queue-operation", operation: "enqueue", timestamp: at(10), content: text },
    attach("q1", 11, text),
    attach("q2", 12, "<task-notification><task-id>a1</task-id><status>completed</status></task-notification>", "task"),
    { type: "assistant", uuid: "a1", timestamp: at(20), message: { role: "assistant", content: [{ type: "text", text: "Found it." }] } },
    attach("q3", 30, "and the same again later"),
    { type: "user", uuid: "u2", timestamp: at(31), message: { role: "user", content: "and the same again later" } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const you = readChat(file).chat.filter((c) => c.role === "you");
  assert.deepEqual(you.map((c) => [c.id, c.text, c.queued]), [["u1", "fix the picker for Sam", undefined], ["q1", text, true], ["q3", "and the same again later", undefined]]);
});

test("chat survives a screenshot in the transcript: one huge line doesn't push every message out of the tail", async () => {
  const { readChat } = await import("../src/dispatcher.ts");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sb-bigline-")), file = path.join(dir, "t.jsonl"), at = (s: number) => new Date(Date.parse("2026-11-02T15:00:00Z") + s * 1000).toISOString();
  const image = { type: "user", uuid: "img", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_r", content: [{ type: "image", source: { type: "base64", data: "A".repeat(700 * 1024) } }] }] } };
  writeFileSync(file, [{ type: "user", uuid: "u1", timestamp: at(0), message: { role: "user", content: "here's a screenshot for Mirza" } }, image,
    { type: "assistant", uuid: "a1", timestamp: at(3), message: { role: "assistant", content: [{ type: "text", text: "I see it." }] } }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  assert.deepEqual(readChat(file).chat.map((c) => c.role), ["you", "switchboard"]);
});

test("spawn without Pocket: our own tmux, through a login shell, name sb-<profile>-<folder>, prompt quoted safely", async () => {
  const { chmodSync, readFileSync: read } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { OWN_TMUX } = await import("../src/tmux.ts");
  assert.equal(OWN_TMUX[1], TEST_SOCKET, "tests run on their own tmux server");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sb-spawn-")), bin = path.join(dir, "bin"), log = path.join(dir, "claude.log");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done > ${log}\necho "cfg=$CLAUDE_CONFIG_DIR" >> ${log}\nsleep 20\n`);
  chmodSync(path.join(bin, "claude"), 0o755);
  const oldPath = process.env.PATH, oldShell = process.env.SHELL;
  process.env.SWITCHBOARD_CLAUDE_BIN = path.join(bin, "claude"); process.env.SHELL = "/bin/sh";
  try {
    const r = await spawnSession({ cwd: "~/Projects/alpha", name: "Try it", prompt: "say $(whoami) and 'hi'" }, { ...config, backend: "tmux" });
    assert.equal(r.backend, "tmux");
    assert.match(r.attach, /^sb attach sb-claude-alpha$/);
    for (let i = 0; i < 40 && !existsSync(log); i++) await new Promise((res) => setTimeout(res, 100));
    const args = read(log, "utf8");
    assert.match(args, /\[-n\]\n\[Try it\]/);
    assert.match(args, /\[--\]\n\[say \$\(whoami\) and 'hi'\]/, "the prompt arrives as written, nothing expanded");
    execFileSync("tmux", [...OWN_TMUX, "has-session", "-t", "=sb-claude-alpha:"]);
  } finally {
    delete process.env.SWITCHBOARD_CLAUDE_BIN; process.env.SHELL = oldShell;
  }
});

after(async () => {
  const { execFileSync } = await import("node:child_process");
  try { execFileSync("tmux", ["-L", TEST_SOCKET, "kill-server"], { stdio: "ignore" }); } catch {}
});

test("running agents: foreground until its result, background until its finish notice; read incrementally", async () => {
  const { runningAgents } = await import("../src/agents.ts");
  const { appendFileSync } = await import("node:fs");
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "sb-ag-")), "t.jsonl");
  const ts = new Date().toISOString();
  const line = (o: object) => appendFileSync(file, JSON.stringify({ timestamp: ts, ...o }) + "\n");
  const use = (id: string, description: string) => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Agent", input: { description, prompt: "p" } }] } });
  const result = (id: string, r?: object) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, ...(r ? { toolUseResult: r } : {}) });
  const notice = (taskId: string, status: string) => line({ type: "attachment", attachment: { type: "queued_command", prompt: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n</task-notification>` } });
  use("t1", "Search the logs"); use("t2", "Build the terminal view"); use("t3", "Quick look");
  writeFileSync(file + ".x", ""); // nothing
  assert.deepEqual(runningAgents(file).map((a) => a.description), ["Search the logs", "Build the terminal view", "Quick look"], "three in flight");
  result("t1", { isAsync: true, status: "async_launched", agentId: "a1", description: "Search the logs" });
  result("t2", { isAsync: true, status: "async_launched", agentId: "a2", description: "Build the terminal view" });
  result("t3"); // a foreground agent that finished
  assert.deepEqual(runningAgents(file).map((a) => [a.id, a.background]), [["a1", true], ["a2", true]]);
  notice("a1", "completed");
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "<task-notification><task-id>a2</task-id><status>completed</status>" }] } }); // quoted in a tool output: not a notice
  assert.deepEqual(runningAgents(file).map((a) => a.id), ["a2"], "a1 done; a2 still running");
  line({ type: "user", message: { role: "user", content: "<task-notification>\n<task-id>a2</task-id>\n<status>completed</status>" } });
  assert.deepEqual(runningAgents(file), [], "all done");
  assert.deepEqual(runningAgents(path.join(os.tmpdir(), "missing.jsonl")), []);
});

/** A live registry entry for one test only (this process's pid, so it counts as alive); removed afterwards. */
async function withExtraSession(entry: { configDir: string; name: string; cwd: string; tmux?: string; kind?: string }, fn: (id: string) => Promise<void>) {
  const { rmSync } = await import("node:fs");
  const file = path.join(home, entry.configDir, "sessions", `${entry.name}.json`), sessionId = `${entry.name.toLowerCase()}-1111-2222`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId, cwd: entry.cwd, kind: entry.kind ?? "interactive", name: entry.name, status: "idle", tmux: entry.tmux, updatedAt: Date.now() }));
  try { await fn(sessionId); } finally { rmSync(file, { force: true }); }
}

/** A fake `claude` (SWITCHBOARD_CLAUDE_BIN) that writes its arguments and CLAUDE_CONFIG_DIR to a log, then waits. */
async function withFakeClaude(fn: (log: () => string) => Promise<void>) {
  const { chmodSync, readFileSync: read } = await import("node:fs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sb-claude-")), bin = path.join(dir, "claude"), log = path.join(dir, "claude.log");
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done > ${log}\necho "cfg=$CLAUDE_CONFIG_DIR" >> ${log}\nsleep 20\n`);
  chmodSync(bin, 0o755);
  const oldShell = process.env.SHELL;
  process.env.SWITCHBOARD_CLAUDE_BIN = bin; process.env.SHELL = "/bin/sh";
  try { await fn(() => (existsSync(log) ? read(log, "utf8") : "")); }
  finally { delete process.env.SWITCHBOARD_CLAUDE_BIN; process.env.SHELL = oldShell; }
}
const waitFor = async (cond: () => boolean) => { for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 100)); };

test("new session folders: recent first (live + spawned), then project folders; deduped; blocked and the dispatcher never listed", async () => {
  const { listFolders } = await import("../src/actions.ts");
  const { appendFileSync } = await import("node:fs");
  mkdirSync(path.join(home, "WebstormProjects", "web-one"), { recursive: true });
  mkdirSync(path.join(home, "Projects", ".hidden"), { recursive: true });
  writeFileSync(path.join(home, "Projects", "notes.txt"), "not a folder");
  appendFileSync(path.join(fx.state, "spawned.jsonl"), JSON.stringify({ name: "x", cwd: fx.folders.client, at: Date.now() }) + "\n");
  const folders = listFolders(config), paths = folders.map((f) => f.path);
  const recent = folders.filter((f) => f.recent).map((f) => f.path);
  assert.deepEqual([...recent].sort(), [fx.folders.a, fx.folders.b, fx.folders.game, fx.folders.ticket].sort(), "live sessions' folders are recent");
  assert.ok(folders.findIndex((f) => !f.recent) >= recent.length, "recent ones come first");
  assert.ok(paths.includes(path.join(home, "WebstormProjects", "web-one")), "children of WebstormProjects");
  assert.equal(new Set(paths).size, paths.length, "no duplicates (alpha is live and a child of ~/Projects)");
  assert.ok(!paths.some((p) => /client-x|\.hidden|notes\.txt|dispatcher/.test(p)), "no blocked, hidden, file or dispatcher entries");
  assert.equal(folders.find((f) => f.path === fx.folders.a)?.label, "~/Projects/alpha");
});

test("new session from the page: spawnSession's guards answer (blocked, prompt, limit); no name → the folder's, made unique", async () => {
  const { startFromPage } = await import("../src/actions.ts");
  const refused = (re: RegExp) => (e: any) => e.status === 400 && re.test(e.message);
  await assert.rejects(startFromPage({ cwd: fx.folders.client, prompt: "p" }, config), refused(/BLOCKED/));
  await assert.rejects(startFromPage({ cwd: fx.folders.a, prompt: "  " }, config), refused(/A prompt is required/));
  await assert.rejects(startFromPage({ cwd: "", prompt: "p" }, config), refused(/Pick a folder/));
  await assert.rejects(startFromPage({ cwd: fx.folders.a, prompt: "p" }, { ...config, maxLiveSpawned: 0 }), refused(/LIMIT/));
  await assert.rejects(startFromPage({ cwd: fx.folders.a, name: "Beta", prompt: "p" }, config), refused(/already called "Beta"/));
  mkdirSync(path.join(home, "Projects", "Waiting"), { recursive: true });
  await withFakeClaude(async (log) => {
    const r = await startFromPage({ cwd: path.join(home, "Projects", "Waiting"), name: " ", prompt: "check ABC-12 for Sam" }, { ...config, backend: "tmux" });
    assert.equal(r.name, "Waiting-2", "a live session is already called Waiting");
    await waitFor(() => /check ABC-12/.test(log()));
    assert.match(log(), /\[-n\]\n\[Waiting-2\]/);
    assert.match(log(), /\[--\]\n\[check ABC-12 for Sam\]/);
  });
});

test("rename: types /rename <name> into its tmux; refused when blocked, not in tmux, empty, the dispatcher or gone", async () => {
  const { renameSession } = await import("../src/actions.ts");
  await withFakeTmux(async (log) => {
    assert.deepEqual(await renameSession(byName.Beta.sessionId, "  Sam's\nrun $(x)  ", config), { name: "Sam's run $(x)" });
    assert.match(log(), /-L pocket send-keys -t =pk-claude-beta: -l -- \/rename Sam's run \$\(x\)\n/, "typed literally, newline flattened");
    assert.match(log(), /send-keys -t =pk-claude-beta: Enter/);
    const before = log();
    await assert.rejects(renameSession(byName.Client.sessionId, "x", config), (e: any) => e.status === 403 && e.blocked === true);
    await assert.rejects(renameSession(byName.Compacted.sessionId, "x", config), (e: any) => e.status === 409 && /doesn't run in tmux/.test(e.message));
    await assert.rejects(renameSession(byName.Beta.sessionId, " \n ", config), (e: any) => e.status === 400);
    await assert.rejects(renameSession(byName.Switchboard.sessionId, "x", config), (e: any) => e.status === 403);
    await assert.rejects(renameSession("no-such-session", "x", config), (e: any) => e.gone === true);
    assert.equal(log(), before, "nothing refused reached tmux");
  });
});

test("end: kill-session only for sb-* (our socket) and pk-* (Pocket's); anything else refused before tmux", async () => {
  const { endSession, ENDABLE } = await import("../src/actions.ts");
  const { OWN_TMUX } = await import("../src/tmux.ts");
  for (const ok of ["sb-claude-alpha", "pk-claude-repo-ABC-12"]) assert.ok(ENDABLE.test(ok), ok);
  for (const bad of ["switchboard", "work", "sb-", "pk-x;rm", "sb-a b", "xsb-a", "-L"]) assert.ok(!ENDABLE.test(bad), bad);
  await withFakeTmux(async (log) => {
    assert.deepEqual(endSession(byName.Beta.sessionId, config), { ended: "pk-claude-beta" });
    assert.match(log(), /^-L pocket kill-session -t =pk-claude-beta:$/m);
    await withExtraSession({ configDir: ".claude", name: "Mirza", cwd: fx.folders.a, tmux: "sb-claude-alpha:@1.%1" }, async (id) => {
      assert.deepEqual(endSession(id, config), { ended: "sb-claude-alpha" });
      assert.ok(log().includes(`${OWN_TMUX.join(" ")} kill-session -t =sb-claude-alpha:`), "our own socket");
    });
    const before = log();
    await withExtraSession({ configDir: ".claude", name: "Other", cwd: fx.folders.a, tmux: "work:@1.%1" }, async (id) => {
      assert.throws(() => endSession(id, config), (e: any) => e.status === 403 && /isn't a Switchboard/.test(e.message));
    });
    assert.throws(() => endSession(byName.Compacted.sessionId, config), (e: any) => e.status === 409);
    assert.throws(() => endSession(byName.Switchboard.sessionId, config), (e: any) => e.status === 403);
    assert.throws(() => endSession("no-such-session", config), (e: any) => e.gone === true);
    assert.equal(log(), before, "nothing refused reached tmux");
  });
});

test("take over: claude --resume <id> in our tmux, in its folder, with its profile's config dir; refused when blocked or already in tmux", async () => {
  const { takeOver } = await import("../src/actions.ts");
  const { OWN_TMUX } = await import("../src/tmux.ts");
  const { execFileSync } = await import("node:child_process");
  assert.throws(() => takeOver(byName.Client.sessionId, config), (e: any) => e.status === 403 && e.blocked === true && /BLOCKED/.test(e.message));
  assert.throws(() => takeOver(byName.Beta.sessionId, config), (e: any) => e.status === 409 && /already runs in tmux/.test(e.message));
  assert.throws(() => takeOver(byName.Switchboard.sessionId, config), (e: any) => e.status === 403);
  await withExtraSession({ configDir: ".claude", name: "Bg", cwd: fx.folders.a, kind: "bg" }, async (id) => {
    assert.throws(() => takeOver(id, config), (e: any) => e.status === 409 && /background/.test(e.message));
  });
  await withExtraSession({ configDir: ".claude", name: "Hidden", cwd: fx.folders.client }, async (id) => {
    assert.throws(() => takeOver(id, config), (e: any) => e.blocked === true, "blocked even when not in tmux");
  });
  await withFakeClaude(async (log) => {
    const r = takeOver(byName.Compacted.sessionId, config);
    assert.match(r.tmux, /^sb-claude-alpha(-\d+)?$/);
    await waitFor(() => /--resume/.test(log()));
    assert.match(log(), /^\[--resume\]\n\[compacted-0000-0000\]\n\[--add-dir\]\n\[[^\]]+\/uploads\]\ncfg=$/m, "default profile: no CLAUDE_CONFIG_DIR");
    const cwd = execFileSync("tmux", [...OWN_TMUX, "display-message", "-p", "-t", `=${r.tmux}:`, "#{pane_current_path}"], { encoding: "utf8" }).trim();
    assert.equal(cwd, fx.folders.a, "started in the session's folder");
  });
  await withExtraSession({ configDir: ".claude-game", name: "Loot", cwd: fx.folders.game }, async (id) => {
    await withFakeClaude(async (log) => {
      const r = takeOver(id, config);
      assert.match(r.tmux, /^sb-game-zomb/);
      await waitFor(() => /cfg=/.test(log()));
      assert.match(log(), new RegExp(`\\[--resume\\]\\n\\[${id}\\][\\s\\S]*cfg=${home}/\\.claude-game$`, "m"), "game profile's config dir");
    });
  });
});

test("changes: git status of the session's folder, one file's diff (untracked = all new); only listed paths; blocked refused before git", async () => {
  const { sessionChanges, sessionDiff, parseStatus, MAX_DIFF } = await import("../src/changes.ts");
  const { makeRepo } = await import("./fixtures.ts");
  const { chmodSync, readFileSync: read } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  makeRepo(fx.folders.b);
  const ch = sessionChanges(byName.Beta.sessionId, config);
  assert.deepEqual([ch.repo, ch.branch, ch.total], [true, "main", 4]);
  assert.deepEqual(ch.files.map((f) => [f.status, f.path]).sort(), [["??", "new.html"], ["??", "sub dir/odd name.md"], ["D", "gone.txt"], ["M", "a.ts"]]);
  const a = sessionDiff(byName.Beta.sessionId, "a.ts", config);
  assert.match(a.diff, /^-const b = 2;$/m); assert.match(a.diff, /^\+const b = 3;$/m); assert.equal(a.cut, false);
  assert.match(sessionDiff(byName.Beta.sessionId, "gone.txt", config).diff, /^-bye$/m);
  const untracked = sessionDiff(byName.Beta.sessionId, "new.html", config);
  assert.match(untracked.diff, /new file mode/); assert.match(untracked.diff, /^\+<script>window.__pwned = 1<\/script>$/m);
  assert.match(sessionDiff(byName.Beta.sessionId, "sub dir/odd name.md", config).diff, /^\+# ABC-12$/m, "spaces in paths");
  for (const bad of ["../../etc/passwd", "/etc/passwd", ".git/config", "a.ts ", "", "sub dir"]) {
    assert.throws(() => sessionDiff(byName.Beta.sessionId, bad, config), (e: any) => e.status === 404, bad);
  }
  writeFileSync(path.join(fx.folders.b, "big.txt"), "x".repeat(MAX_DIFF + 5000));
  const big = sessionDiff(byName.Beta.sessionId, "big.txt", config);
  assert.ok(big.cut && big.diff.length === MAX_DIFF, "capped");
  assert.deepEqual(sessionChanges(byName.Compacted.sessionId, config).repo, false, "alpha isn't a repo");
  assert.deepEqual(parseStatus("R  new.ts\0old.ts\0 M a b.ts\0"), [{ path: "new.ts", status: "R" }, { path: "a b.ts", status: "M" }]);
  // Blocked (client) folder: refused, and git never runs. A logging git on PATH proves it.
  const dir = mkdtempSync(path.join(os.tmpdir(), "sb-git-")), log = path.join(dir, "git.log"), realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(dir, "git"), `#!/bin/sh\necho "$@" >> ${log}\nexec ${realGit} "$@"\n`); chmodSync(path.join(dir, "git"), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${dir}:${oldPath}`;
  try {
    sessionChanges(byName.Beta.sessionId, config);
    assert.ok(existsSync(log), "the logging git is the one used");
    const before = read(log, "utf8");
    assert.throws(() => sessionChanges(byName.Client.sessionId, config), (e: any) => e.status === 403 && e.blocked === true);
    assert.throws(() => sessionDiff(byName.Client.sessionId, "a.ts", config), (e: any) => e.status === 403 && e.blocked === true);
    assert.throws(() => sessionChanges(byName.Switchboard.sessionId, config), (e: any) => e.status === 403);
    assert.throws(() => sessionChanges("no-such-session", config), (e: any) => e.gone === true);
    assert.equal(read(log, "utf8"), before, "no git for refused sessions");
  } finally { process.env.PATH = oldPath; }
});

test("trust prompt: a spawned session waiting at it is listed (not when blocked or registered) and Trust it presses Down, Enter", async () => {
  const { waitingForTrust, trustSession } = await import("../src/actions.ts");
  const { OWN_TMUX } = await import("../src/tmux.ts");
  const { execFileSync } = await import("node:child_process");
  const { appendFileSync, readFileSync } = await import("node:fs");
  const log = path.join(fx.state, "spawned.jsonl");
  const before = existsSync(log) ? readFileSync(log, "utf8") : "";
  const keys = path.join(home, "trust-keys.txt");
  // A pane that prints the prompt, then records what is typed into it.
  const pane = `printf 'Do you trust this folder?\\n'; stty -echo; cat > ${keys}`;
  for (const t of ["sb-claude-alpha-9", "sb-claude-client-x-9"]) execFileSync("tmux", [...OWN_TMUX, "new-session", "-d", "-s", t, "sh", "-c", pane]);
  const at = Date.now();
  appendFileSync(log, [
    { name: "Alpha new", cwd: fx.folders.a, profile: "claude", attach: "sb attach sb-claude-alpha-9", at },
    { name: "Client new", cwd: fx.folders.client, profile: "claude", attach: "sb attach sb-claude-client-x-9", at },
    { name: "Old one", cwd: fx.folders.a, profile: "claude", attach: "sb attach sb-claude-alpha-9", at: at - 7 * 3_600_000 },
    { name: "Beta", cwd: fx.folders.b, profile: "claude", attach: "tmux -L pocket attach -t pk-claude-beta", at },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  try {
    await waitFor(() => waitingForTrust(config).length > 0);
    assert.deepEqual(waitingForTrust(config).map((w) => [w.name, w.tmux]), [["Alpha new", "sb-claude-alpha-9"]]);
    assert.throws(() => trustSession("sb-claude-client-x-9", config), (e: any) => e.status === 404, "blocked: never typed into");
    assert.throws(() => trustSession("pk-claude-beta", config), (e: any) => e.status === 404, "registered: not waiting");
    assert.deepEqual(trustSession("sb-claude-alpha-9", config), { trusted: "Alpha new" });
    await waitFor(() => existsSync(keys) && readFileSync(keys, "utf8").length > 0);
    assert.match(readFileSync(keys, "utf8"), /\x1b(\[|O)B/, "Down arrow sent");
  } finally {
    for (const t of ["sb-claude-alpha-9", "sb-claude-client-x-9"]) try { execFileSync("tmux", [...OWN_TMUX, "kill-session", "-t", `=${t}:`], { stdio: "ignore" }); } catch {}
    writeFileSync(log, before);
  }
});

// ---- AskUserQuestion picker. Screens are real `capture-pane -p` captures of Claude Code 2.1.300 (2026-10-30), names swapped. ----
const RULE = "─".repeat(60);
const PICKER_FIRST = `❯ Ask me a few things for ABC-12.
${RULE}
←  ☐ Colour  ☐ Extras  ☐ Size  ✔ Submit  →

Which colour should Sam use?

❯ 1. Red
     Warm, bold red
  2. Green
     Cool, natural green
  3. Blue
     Calm, classic blue
  4. Type something.
${RULE}
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;
const PICKER_MULTI = `${RULE}
←  ☒ Colour  ☒ Extras  ☐ Size  ✔ Submit  →

Which extras does Mirza want?

  1. [✔] Cheese
         Melted cheese topping
  2. [ ] Olives
         Sliced black or green olives
  3. [✔] Basil
         Fresh basil leaves
❯ 4. [✔] Mushrooms
     Next
${RULE}
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel`;
const PICKER_REVIEW = `${RULE}
←  ☒ Colour  ☒ Extras  ☒ Size  ✔ Submit  →

Review your answers

 ● Which colour should Sam use?
   → Green
 ● Which extras does Mirza want?
   → Cheese, Basil, Mushrooms
 ● Which size?
   → Medium please

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel`;
const PICKER_ONE = `${RULE}
 ☐ Plan

Which plan for ABC-12?

❯ 1. Alpha
     The first plan option
  2. Beta
     The second plan option
  3. Type something.
${RULE}
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`;

// A long question wraps inside a "│ " quote box (shape of a real 4-question capture, 2026-11-02, text swapped).
const PICKER_BOXED = `${RULE}
←  ☐ Job home  ☐ New item  ☐ Recipients  ☐ Go  ✔ Submit  →

│ D1: Where should the daily job for ABC-12 run? The list and the 'team → its members' roll-up both live in
│ the first service.

❯ 1. First service (Recommended)
     Reuses the existing roll-up query; the mail service still sends the email
  2. Second service (as the ticket says)
     Would need a copy of the roll-up query
  3. Type something.
${RULE}
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;

test("picker screens: tabs, question, rows, boxes, highlighted row, the review step (real captures)", async () => {
  const { parsePicker } = await import("../src/asks.ts");
  const first = parsePicker(PICKER_FIRST)!;
  assert.deepEqual(first.tabs, [{ label: "Colour", done: false }, { label: "Extras", done: false }, { label: "Size", done: false }]);
  assert.equal(first.title, "Which colour should Sam use?");
  assert.deepEqual(first.rows.map((r) => [r.n, r.label, r.checked, r.cursor]),
    [[1, "Red", undefined, true], [2, "Green", undefined, false], [3, "Blue", undefined, false], [4, "Type something.", undefined, false], [5, "Chat about this", undefined, false]], "descriptions aren't rows");
  const multi = parsePicker(PICKER_MULTI)!;
  assert.deepEqual(multi.rows.map((r) => [r.n, r.label, r.checked, r.cursor]),
    [[1, "Cheese", true, false], [2, "Olives", false, false], [3, "Basil", true, false], [4, "Mushrooms", true, true], [undefined, "Next", undefined, false], [5, "Chat about this", undefined, false]]);
  const review = parsePicker(PICKER_REVIEW)!;
  assert.deepEqual([review.review, review.incomplete, review.answers, review.rows.find((r) => r.cursor)?.label], [true, false, ["Green", "Cheese, Basil, Mushrooms", "Medium please"], "Submit answers"]);
  assert.equal(parsePicker(PICKER_REVIEW.replace("Review your answers\n", "Review your answers\n\n⚠ You have not answered all questions\n"))!.incomplete, true);
  const boxed = parsePicker(PICKER_BOXED)!;
  assert.equal(boxed.title, "D1: Where should the daily job for ABC-12 run? The list and the 'team → its members' roll-up both live in the first service.", "quote box: gutter dropped, wrapped lines joined");
  assert.deepEqual(boxed.rows.map((r) => [r.n, r.cursor]), [[1, true], [2, false], [3, false], [4, false]]);
  assert.deepEqual(parsePicker(PICKER_ONE)!.tabs, [{ label: "Plan", done: false }], "one question: no arrows, no Submit tab");
  assert.equal(parsePicker(" Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"), undefined, "a permission dialog isn't a picker");
  assert.equal(parsePicker("- ☐ write the tests\n- ☒ ship it\n"), undefined, "a checklist in a reply isn't one either");
  assert.deepEqual([askFromScreen(PICKER_FIRST)?.picker, askFromScreen(PICKER_FIRST)?.options], [true, []], "on screen: waiting on you");
});

test("picker answers: checked against the questions before any key (one per question, real options, text cleaned)", async () => {
  const { checkAnswers } = await import("../src/picker.ts");
  const qs = [{ question: "A?", header: "A", options: [{ label: "x" }, { label: "y" }] }, { question: "B?", multiSelect: true, options: [{ label: "p" }, { label: "q" }] }];
  assert.deepEqual(checkAnswers(qs, [{ picks: [1] }, { picks: [1, 0], other: " own\x1b[31m text\n" }]), [{ picks: [1] }, { picks: [0, 1], other: "own [31m text" }]);
  for (const [bad, why] of [[[{ picks: [0] }], /One answer per question/], [[{ picks: [2] }, { picks: [0] }], /isn't in the question/], [[{ picks: [0, 1] }, { picks: [0] }], /takes one answer/],
    [[{ picks: [] }, { picks: [0] }], /Answer “A” first/], [[{ picks: [0] }, { picks: [], other: "  " }], /untick Other/], [[{ picks: ["0"] }, { picks: [0] }], /isn't in the question/], ["x", /One answer/]] as const)
    assert.throws(() => checkAnswers(qs, bad), (e: any) => e.status === 400 && why.test(e.message), JSON.stringify(bad));
});

test("picker driving: every flow presses the right keys and checks the screen after each one (scripted picker)", async () => {
  const { drivePicker } = await import("../src/picker.ts");
  const { newPicker, press, render } = await import("./fake-picker.ts");
  const run = async (qs: any[], answers: any[], extra = {}) => {
    const st = newPicker(qs, extra);
    let captures = 0;
    const io = { screen: () => (captures++, render(st)), press: (a: string[]) => press(st, a) };
    try { return { texts: await drivePicker(io, qs, answers, { timeoutMs: 200, pollMs: 10 }), keys: st.keys, closed: st.closed, answers: st.answers, captures }; }
    catch (e: any) { return { error: e.message, detail: e.detail, keys: st.keys, closed: st.closed }; }
  };
  const colour = { question: "Which colour should Sam use?", header: "Colour", options: [{ label: "Red", description: "Warm, bold red" }, { label: "Green" }, { label: "Blue" }] };
  const extras = { question: "Which extras does Mirza want?", header: "Extras", multiSelect: true, options: [{ label: "Cheese" }, { label: "Olives" }, { label: "Basil" }] };
  const size = { question: "Which size?", header: "Size", options: [{ label: "Small" }, { label: "Large" }] };
  // One question: the pick is sent by its Enter (no review step).
  const one = await run([colour], [{ picks: [1] }]);
  assert.deepEqual([one.keys, one.closed, one.texts], [["Down", "Enter"], "submitted", ["Green"]]);
  const first = await run([colour], [{ picks: [0] }]);
  assert.deepEqual(first.keys, ["Enter"], "already highlighted: just Enter");
  // One question, your own text on the Type something row.
  const own = await run([colour], [{ picks: [], other: "Teal, -dark" }]);
  assert.deepEqual([own.keys, own.closed, own.texts], [["Down", "Down", "Down", "-l -- Teal, -dark", "Enter"], "submitted", ["Teal, -dark"]]);
  // Several questions, multiSelect with Other, then the review step and Submit.
  const many = await run([colour, extras, size], [{ picks: [1] }, { picks: [2, 0], other: "Mushrooms" }, { picks: [], other: "Medium please" }]);
  assert.deepEqual(many.keys, ["Down", "Enter", "Space", "Down", "Down", "Space", "Down", "-l -- Mushrooms", "Down", "Enter", "Down", "Down", "-l -- Medium please", "Enter", "Enter"]);
  assert.deepEqual([many.closed, many.texts], ["submitted", ["Green", "Cheese, Basil, Mushrooms", "Medium please"]]);
  // Four long questions (each wraps inside a "│ " quote box), as in the 2026-11-02 bug: answered, not refused.
  const long = (n: number, tail: string) => ({ question: `D${n}: ${"Where should the daily job for ABC-12 run, given that Sam and Mirza both own parts of it? ".repeat(2)}${tail}`,
    header: `Q${n}`, options: [{ label: "Go", description: "Write failing tests first, then build" }, { label: "Change the plan first" }] });
  const boxedQs = [long(1, "One?"), long(2, "Two?"), long(3, "Three?"), long(4, "spec + test. Go?")];
  assert.ok(render(newPicker(boxedQs)).includes("│ D1: Where should"), "the fake draws the quote box");
  const boxedRun = await run(boxedQs, [{ picks: [0] }, { picks: [1] }, { picks: [0] }, { picks: [0] }]);
  assert.deepEqual([boxedRun.error, boxedRun.keys, boxedRun.closed], [undefined, ["Enter", "Down", "Enter", "Enter", "Enter", "Enter"], "submitted"]);
  // A multiSelect question on its own still has the review step.
  const ms = await run([extras], [{ picks: [1] }]);
  assert.deepEqual([ms.keys, ms.closed], [["Down", "Space", "Down", "Down", "Down", "Enter", "Enter"], "submitted"]);
  // Mismatches stop at once and leave the picker as it is (never Esc):
  const moved = await run([colour, extras], [{ picks: [0] }, { picks: [0] }], { startTab: 1 });
  assert.deepEqual([moved.error, moved.keys, moved.closed], ["Couldn't answer automatically, use the Terminal tab", [], ""], "someone already moved on: no keys at all");
  // The screen shows a different question (or other options) than the transcript's: nothing pressed.
  for (const shown of [[size], [{ ...colour, options: [{ label: "Red" }, { label: "Purple" }, { label: "Blue" }] }]]) {
    const st = newPicker(shown);
    const r = await drivePicker({ screen: () => render(st), press: (a) => press(st, a) }, [colour], [{ picks: [1] }], { timeoutMs: 100, pollMs: 10 }).catch((e) => e);
    assert.deepEqual([r.message, st.keys], ["Couldn't answer automatically, use the Terminal tab", []], shown[0].question);
  }
  const missed = await run([colour, size], [{ picks: [2] }, { picks: [0] }], { drop: 1 });
  assert.deepEqual([missed.error, missed.keys, missed.closed], ["Couldn't answer automatically, use the Terminal tab", ["Down", "Down"], ""], "a key that didn't land: stops right after it");
  assert.match(missed.detail, /row 3 highlighted/);
  const ticked = await run([extras], [{ picks: [0] }], {});
  assert.equal(ticked.closed, "submitted");
  const pre = newPicker([extras]); press(pre, ["Space"]); pre.keys = [];
  const preTicked = await drivePicker({ screen: () => render(pre), press: (a) => press(pre, a) }, [extras], [{ picks: [1] }], { timeoutMs: 100, pollMs: 10 }).catch((e) => e);
  assert.deepEqual([preTicked.message, pre.keys], ["Couldn't answer automatically, use the Terminal tab", []], "a box already ticked in the terminal: nothing pressed");
});

test("answerPicker: keys go to the session's own tmux pane, checked by capture-pane each step; guards refuse before tmux", async () => {
  const { answerPicker } = await import("../src/picker.ts");
  const { newPicker } = await import("./fake-picker.ts");
  const { chmodSync, readFileSync: read } = await import("node:fs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sb-picker-")), bin = path.join(dir, "bin"), file = path.join(dir, "picker.json");
  mkdirSync(bin);
  // A fake tmux that IS the scripted picker (test/fake-picker.ts), showing the fixture's open question.
  writeFileSync(path.join(bin, "tmux"), `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${path.join(import.meta.dirname, "fake-picker.ts")}" "$@"\n`);
  chmodSync(path.join(bin, "tmux"), 0o755);
  const s = byName["repo-abc-12-93"];
  const ship = { question: "Ship it now?", header: "Ship", multiSelect: false, options: [{ label: "Yes, ship" }, { label: "Wait for review" }] };
  writeFileSync(file, JSON.stringify(newPicker([ship])));
  const state = () => JSON.parse(read(file, "utf8"));
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`; process.env.FAKE_PICKER_STATE = file;
  const opts = { timeoutMs: 1500, pollMs: 20 };
  try {
    assert.deepEqual(await answerPicker(s.sessionId, ["Ship it now?"], [{ picks: [1] }], config, opts), { ok: true, answers: ["Wait for review"] });
    const st = state();
    assert.deepEqual([st.keys, st.closed], [["Down", "Enter"], "submitted"]);
    assert.ok(st.calls.every((c: string) => c.startsWith("-L pocket ") && c.includes("-t =pk-claude-repo-ABC-12:")), "only its own pane, on Pocket's socket");
    assert.ok(st.calls.filter((c: string) => c.includes("capture-pane -p")).length >= 3, "the screen was checked between keys");
    // The transcript still says it's asking, but the picker is gone: refused, nothing pressed.
    await assert.rejects(answerPicker(s.sessionId, ["Ship it now?"], [{ picks: [0] }], config, { timeoutMs: 200, pollMs: 20 }), (e: any) => e.status === 409 && e.message === "Couldn't answer automatically, use the Terminal tab");
    assert.equal(state().keys.length, 2, "no key after a mismatch");
    const calls = state().calls.length;
    await assert.rejects(answerPicker(byName.Client.sessionId, ["x"], [{ picks: [0] }], config, opts), (e: any) => e.status === 403 && e.blocked === true);
    await assert.rejects(answerPicker(byName.Waiting.sessionId, ["x"], [{ picks: [0] }], config, opts), (e: any) => e.status === 409 && /doesn't run in tmux/.test(e.message));
    await assert.rejects(answerPicker(byName.Switchboard.sessionId, ["x"], [{ picks: [0] }], config, opts), (e: any) => e.status === 403);
    await assert.rejects(answerPicker(byName.Beta.sessionId, ["x"], [{ picks: [0] }], config, opts), /isn't asking anything/);
    await assert.rejects(answerPicker(s.sessionId, ["Ship it later?"], [{ picks: [0] }], config, opts), /isn't waiting any more/);
    await assert.rejects(answerPicker(s.sessionId, ["Ship it now?"], [{ picks: [5] }], config, opts), (e: any) => e.status === 400);
    await assert.rejects(answerPicker("no-such-session", [], [], config, opts), (e: any) => e.gone === true);
    assert.equal(state().calls.length, calls, "refused ones never reached tmux");
  } finally { process.env.PATH = oldPath; delete process.env.FAKE_PICKER_STATE; }
});

test("waiting on you: an open AskUserQuestion marks the session needs-you even when the registry says idle", async () => {
  const id = "asker-1111-2222", cwd = fx.folders.a;
  const transcript = path.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
  writeFileSync(transcript, JSON.stringify({ type: "assistant", uuid: "q1", timestamp: new Date().toISOString(), message: { model: "claude-test",
    content: [{ type: "tool_use", id: "toolu_q1", name: "AskUserQuestion", input: { questions: [{ question: "A?", header: "A", options: [{ label: "x" }] }, { question: "B?", header: "B", multiSelect: true, options: [{ label: "y" }] }] } }],
    usage: { input_tokens: 10 } } }) + "\n");
  try {
    await withExtraSession({ configDir: ".claude", name: "Asker", cwd, tmux: "sb-claude-alpha:@1.%1" }, async () => {
      const s = listSessions(config).find((x) => x.name === "Asker")!;
      assert.deepEqual([s.state, s.ask?.picker, s.ask?.options, /2 questions/.test(s.ask?.note ?? "")], ["needs-you", true, [], true]);
    });
  } finally { const { rmSync } = await import("node:fs"); rmSync(transcript, { force: true }); }
});
