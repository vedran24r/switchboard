# switchboard
Voice-first dispatcher plus a bubble-map dashboard for every Claude Code session on this Mac. Kind: personal tool. Launch: `cd ~/Projects/switchboard && claude`.
Personal preferences load from `~/.claude/vedran.md`.

This file is for *developing* Switchboard. The dispatcher's own rules are in `dispatcher/CLAUDE.md`
(`sb up` runs it from `~/.switchboard/dispatcher/`, symlinked, so the two never mix).

## How it works / how to run
- `src/sessions.ts`: live sessions from `<config dir>/sessions/<pid>.json` (Claude Code's own registry,
  also used by cross-session messaging) for every `~/.claude*` profile, and context and last ask/reply
  from the transcript tail. No hooks, no daemon.
- `src/spawn.ts`: guarded spawn. Pocket (`POST /api/sessions` with `name`/`prompt`, auth via
  `~/.pocket-sessions/access-key`) when it's running, else `claude --bg -n`. Logs to `~/.switchboard/spawned.jsonl`.
- `src/dispatcher.ts`: the dispatcher is an interactive session named "Switchboard" in `~/.switchboard/dispatcher`,
  in tmux (Pocket's when it runs, else `tmux -L switchboard`). The map types into it (Pocket `/api/sessions/<tmux>/send`,
  typed not pasted so it counts as Vedran's input) and reads its transcript for the chat panel and the routes:
  `SendMessage` and `sb spawn` tool calls become the "flying request" animations.
- `src/server.ts` + `web/index.html`: the map (no build step, no deps). `sb map` → http://127.0.0.1:8790, kept
  alive by launchd (`scripts/install-launchd.sh`, label `ai.switchboard.map`, log `~/.switchboard/map.log`).
  POSTs need same-origin + `x-switchboard: 1` + JSON, so other websites can't type into the dispatcher.
- No build: Node 26 runs the `.ts` files directly. No dependencies.

## Decisions & pitfalls
- Context % uses a 1M window. Opus sessions here run well past 200k. The handoff flag is absolute
  (`handoffTokens`, default 300k), because cost grows with tokens re-read per turn, not with %.
- `claude agents --json` is in the docs but not in CLI 2.1.300 ("unknown option"), so read the registry.
- Pocket's tmux socket is `-L pocket`. Pocket needs `name`/`prompt` support in `startSession`
  (added 2026-10-21 in pocket-sessions `server/server.ts`).
- A never-opened folder shows Claude's trust prompt first. The spawned session isn't in the registry
  (or on the map) until someone accepts it in the terminal or on the phone.
  `waitingForTrust` (actions.ts) finds those: spawns from the last 6 h whose sb-*/pk-* tmux is alive, unregistered, and shows the
  prompt (blocked folders skipped before the pane is read). `/api/state` `trustWaits` → grey rows; "Trust it" = Down, Enter, only for a listed one.
- `ListAgents` may not list `game`-profile sessions, so the dispatcher can't message those.
- The dispatcher's model is set in `dispatcher/settings.json` (`"model": "sonnet"`), because Pocket's start API has no model field.
- Rebuilding notice/chat HTML on every poll swallows clicks: only touch the DOM when the content changed.
- Voice: the browser records WAV (ScriptProcessor, downsampled to 16 kHz), posts it to `/api/transcribe`, and the server
  forwards it to `whisper-server` (8791, started on demand by `src/voice.ts`). Web Speech API isn't in Firefox and fn-fn is
  bound to emoji on this Mac, so don't rely on either. Recording WAV in the browser avoids needing ffmpeg.
- `SendMessage` only sees sessions on the dispatcher's own profile. `sb send` covers the rest (game) by typing into tmux,
  guarded by `sendProfiles` + `blocked`. The dispatcher's settings.json pre-allows `sb ls/spawn/send/pulse` (his call; don't widen it without his OK).
- Hands-free VAD: 64–85 ms blocks, threshold max(0.012, 3×noise floor), 900 ms silence ends a piece, pieces under
  200 ms of speech are dropped (350 ms dropped a real "Send it"). Test without a mic: feed `say -o x.wav --data-format=LEI16@16000`
  audio through `hfBlock()` from devtools with `sayText` stubbed.
- Context after /compact: a `system`/`compact_boundary` entry after the last reply carries `compactMetadata.postTokens`;
  use that, or Dev/Misc stay "758k" and red until their next reply.
- Noise gate test (synthetic, 2026-10-21): background 12 dB under the voice passed at sensitivity 14, blocked at 8 → default 10.
- Scroll jumps: never resize the textarea via `height: auto` (it briefly grows the log and the browser clamps scrollTop);
  measure on a hidden mirror. Status lines under the input have fixed heights. Each log has a ResizeObserver that keeps
  the bottom if you were there, else restores scrollTop.

- Whisper with a `prompt` can keep writing Cyrillic even when the language is forced; the re-run retries without the prompt, then `toLatin`. Language odds come from `verbose_json` `language_probabilities` (top entries only).
- Phone access (`src/access.ts`): the server stays on 127.0.0.1; `tailscale serve` (HTTPS 8443) proxies from loopback with
  `Host: <mac>.<tailnet>.ts.net:8443` and `Tailscale-User-Login`. Trust that header only on a loopback socket + ts.net host +
  `remoteLogins`. POST origin is then `https://<host>`. Pocket already owns serve's `/` on 443, so don't touch that.
- Phone layout = `body.phone` (≤700px, `setPhone`), not a second page: same JS. The session sheet (`#panel`) and `#settings`
  are moved out of `#mapwrap` on a phone, because the map pane is display:none on other tabs (fixed children vanish too).
  Grid columns need `minmax(0, 1fr)` or long lines widen the page. Headless Chrome windows can't go under ~500px:
  screenshot phone size through a 390px iframe. `tick()` skips the physics while the map isn't visible.

- Access modes: local, SSH tunnel (any loopback port: `LOCAL_HOST` in access.ts) and Tailscale. Never bind a LAN address.
  This Mac has Remote Login off. Test tunnels with a reverse one: `ssh -f -N -R 9000:127.0.0.1:8790 winpc`, then curl on winpc.
- Connection loss: `request()` = fetch + timeout, network errors get `.net`. Only `.net` failures auto-retry (on reconnect
  in `setOnline`, or `online`). Outbox `sb-outbox` holds sending/failed messages. The server's `typeOnce` dedupes by message id
  (10 min). `transcribeWav` waits for the connection instead of dropping audio. Tests stub `window.fetch` in the phone frame.
- Quick replies (`askFromText`): numbered items that are questions aren't choices (2+ → `note`, no buttons). "A, or B?" → the two
  answers (`eitherOr`). Unquoted "reply X" only for short answer words (`BARE_ANSWER`). Test shapes come from real replies, with names swapped.
- Tool grouping is in the page, not the server: `makeLog` puts groupable rows (`role tool`, no `session`) into the last `.tgroup`
  (`addToGroup`/`refreshGroup`); st.els maps ids to the rows inside groups, so redraw/drop still work. `aside details` has
  margins, and rows inside the popup need `margin: 0` or each row is 32px tall.
- AskUserQuestion: `readChat` turns it into `role: "ask"` cards with answers from `toolUseResult.answers` (multiSelect and
  Other come back as one string, "Cheese, Ham": picked labels in option order, then your text). `readTranscript` sets
  `question` while its tool_use has no tool_result (the tool_use is written before the picker shows); that also makes the
  session needs-you. The registry says `status: "waiting"`, `waitingFor: "input needed"` while a picker is up.
- The real picker (Claude Code 2.1.300, studied on a private tmux 2026-10-30; `parsePicker` in asks.ts, `drivePicker` in picker.ts):
  tab bar `←  ☐ A  ☒ B  ✔ Submit  →` (one single-select question: just ` ☐ A`, no review step), the current tab is only
  colour (so check the question text), rows `❯ 1. label` / `  2. label` at column 0 with descriptions indented under them,
  then `N. Type something.`; multiSelect rows are `[ ]`/`[✔]` plus a `Next` (last question: `Submit`) row. The cursor
  starts on 1 on every question (also when revisiting; a picked single answer then shows `label ✔`). ↓/↑ move; single:
  Enter picks and moves on, a number key picks and moves on; multi: Space or Enter toggles, a number toggles without
  moving. Typing on the Type something row writes there at once (no Enter first) and ticks it in multi; digits typed there
  are text. ←/→ and Tab switch tabs. Review: `Review your answers`, ` ● question` / `   → answer`, `⚠ You have not answered
  all questions` if any is empty, `❯ 1. Submit answers` / `2. Cancel`. **Esc cancels the whole picker**: never press it.
- `drivePicker` only moves down, verifies the whole question (title, every label, boxes, the one highlighted row, other tabs'
  ☐/☒) after every key, and stops on the first surprise (409 "Couldn't answer automatically…", `detail` says which step).
  Tests: `test/fake-picker.ts` is a scripted picker drawn like the real captures; run as a script it's a fake `tmux`
  (state in `$FAKE_PICKER_STATE`). The browser tests route `pk-claude-repo-ABC-12` to it.
- A long question is drawn wrapped inside a `│ ` quote box (`│ D1: Where should…` / `│ …rest`); `parsePicker` drops the gutter
  and joins the lines, and `same()` ignores spaces (a wrap may split a word). Without that every long question got
  "Couldn't answer automatically" before a key was pressed (2026-11-02). The fake picker draws the box for questions > 96 chars.
- `tmux send-keys -l "-x"` fails ("unknown flag -x"): typed text goes after `-l --`.
- `display` (sessions.ts `displayName`): auto = lowercase folder + optional `-<hex>`; a cased name like "Beta" is someone's.
- Pocket's API rejects session names with uppercase (`SESSION_RE` `^(pk|ro)-[a-z0-9._-]+$`, "bad session"), yet names sessions
  after the folder (`pk-claude-repo-ABC-12`). `POCKET_NAME` in dispatcher.ts sends those straight to `tmux -L pocket` instead.
  Ended targets throw `GoneError` → HTTP 410 `{gone}` → the page shows "<name> isn't running any more" with no Retry.
- `!cmd` is recorded as a user line `<bash-input> cmd</bash-input>` then `<bash-stdout>…</bash-stdout><bash-stderr>…`; /commands as
  `<command-name>/x</command-name>…<command-args>…` then `<local-command-stdout>`. `readChat` makes them `role: "shell"` (with
  `output`) so pending "!…"/"/…" messages settle. Unmatched ones turn "untracked" after 15 s idle (/clear starts a new transcript).
- `sb run` = `bin/sb-run` (bash, a port of `pocket run`): `tmux -L switchboard -f tmux.conf`, names `sb-<profile>-<folder>`
  (lowercase), env handed over, destroy-unattached on attach. `bin/sb` routes run/attach/sessions there. Spawn backend "tmux"
  (`auto` without Pocket) starts `$SHELL -lic "exec command claude …"` with `shQuote`d args. Tests set `SWITCHBOARD_TMUX_SOCKET`
  (and `SWITCHBOARD_CLAUDE_BIN` for spawn) so they never touch the real server; a login shell rebuilds PATH, so a fake
  `claude` on PATH isn't enough. When running *inside* tmux (like this dev session), `sb run` execs claude directly: test with `env -u TMUX`.
- Running agents (`src/agents.ts`): incremental per-transcript scan (offset + carry-over partial line). Foreground = Agent/Task
  tool_use without tool_result; background = tool_result `toolUseResult.isAsync` + `agentId` until a `<task-notification>`
  (queued_command attachment or user text, NOT text quoted inside a tool_result) with a final status. Stale ones age out (6 h / 24 h).
- Terminal view (`sessionScreen`, `GET /api/session/screen`): `capture-pane -e -p` on `socketFor(name)`; blocked folders get
  403 `{blocked}` before tmux is ever called. The page converts ANSI itself (`ansiToHtml`: every text run through `esc()`,
  styles built only from numbers) and polls 1 s only while the Terminal view shows and `!document.hidden` (`termRun` token);
  400 ms while `dialogOnScreen` sees a picker/permission footer or a `❯ 1.` row (`termFast`). The keys row wraps (no
  sideways scroll on a phone). Type text posts `/api/session/say` with `quick: true` and its own id, not via `sayToSession`
  (text typed into a picker never shows up as a "you" line, so a pending line would turn "not picked up").
- Keys: `KEYS` in dispatcher.ts is a Map (an object would accept "constructor"). Page names match Pocket's (`stab`, `ctrlc`);
  keys Pocket's API doesn't know (6–9, or an older Pocket answering "unknown key") go straight to tmux.
- Browser tests: the test server's PATH has a tmux wrapper (test/browser.ts) that answers `-L pocket` capture-pane for
  pk-claude-beta and swallows send-keys, so fixture pk-* sessions never hit the real Pocket server. In test.html, a
  `</script>` inside a string ends the test page's own script: write `<\/script>`. The `/test/` route used to crash the
  server on a missing file (headers already sent); it now 404s.
- Counting fetches around `dispatchEvent("visibilitychange")`: the listener runs synchronously, so read the count first.
- Duplicate registry entries (same sessionId under two pids/cwds, e.g. ticket worktrees) are deduped in `listSessions`, newest
  `updatedAt` wins. A `Write` to `…/handoffs/*.md` or `…/_handoffs/*.md` since the last prompt sets `handoffNote` and clears `needsHandoff`.
- ＋ New (`src/actions.ts`): `listFolders` filters with config's `isBlocked`, `startFromPage` only fills in a default name and
  calls `spawnSession`, so every guard stays in one place. Browser tests stub `/api/spawn` for the success path: the test
  server's backend is "bg", which would start a real `claude --bg`. The real route is only hit with a blocked folder.
  The tmux spawn path is `startInOwnTmux` (spawn.ts), shared with take-over. Browser test port: `SWITCHBOARD_TEST_PORT`
  (8797 clashes when two worktrees run `npm test` at once).
- Session actions (actions.ts): End kills only `ENDABLE` names (`sb-*` on `socketFor`, `pk-*` on `-L pocket`), via execFile args.
  Take over is `claude --resume <id>` (not `--fork-session` like Pocket's), so the confirm tells you to close the original
  first; its CLAUDE_CONFIG_DIR is `configDirs[profile]`, else the registry's own dir (unset for `~/.claude`). Browser tests stub
  `/api/session/takeover` (the real one would start a real claude); the tmux wrapper logs `kill-session` for `-L pocket`.
- Changes view (`src/changes.ts`): `git --no-optional-locks -c core.fsmonitor=false` (a session may be committing; no repo
  hooks), status paths are relative to the repo root, so diff from `rev-parse --show-toplevel`. `file` must equal a path
  status returned, else 404. Untracked = `diff --no-index /dev/null` (exits 1 on a difference). Blocked → 403 before git.
  The page loads it on open and ↻ only (no polling). Tests build the repo with `makeRepo` (fixtures.ts, hooks/signing off).
