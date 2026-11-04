# Switchboard

**One voice channel for many Claude Code sessions.**

You talk (or type) to one dispatcher session, **Switchboard**. It splits what you said into tasks, sends each to the
session it belongs to (or starts a new one in the right folder), and answers in a line per task. One **page** holds it all: the
Switchboard chat on the left, every live session on this Mac in a list in the middle, and the session you picked open on
the right, with its chat, terminal and changes. Questions sessions ask you show as cards in the chat, answered with one
click. The same page works on a phone.

No build step, no npm dependencies: Node runs the TypeScript directly. Nothing listens beyond `127.0.0.1`.

## Quick start
Needs macOS, Node 26+, tmux, Claude Code, and Google Chrome (only for the browser tests).
```bash
ln -s ~/Projects/switchboard/bin/sb ~/.local/bin/sb    # the CLI
scripts/install-launchd.sh                              # keep the map running: http://127.0.0.1:8790
cp config.example.json ~/.switchboard/config.json       # then edit: your folders, blocked folders, looks
sb up                                                   # start the dispatcher and open the map
```
First time only, the map asks you to **Start Switchboard**, then **Trust it**, because Claude asks once to trust
`~/.switchboard/dispatcher`.

**Voice (optional).** Speech is transcribed on this Mac by whisper.cpp. No audio leaves the machine, and it works in any
browser.
```bash
brew install whisper-cpp
mkdir -p ~/.switchboard/models && curl -L -o ~/.switchboard/models/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin   # ~550 MB
```
The map starts `whisper-server` on 127.0.0.1:8791 by itself when it's needed.

### Commands (`sb help`)
```bash
sb up                         # dispatcher + map, opens the browser
sb map                        # serve only the map (what launchd runs)
sb ls [--json]                # every live session: state, context (! = hand off), last activity, folder
sb say "what's waiting on me?"            # type into the dispatcher from a terminal
sb spawn --cwd ~/Projects/x --name "short name" [--group G] "first task"   # start a session (guarded)
sb send "PZ" "check the inventory"        # type into a session by name (profiles in sendProfiles only)
sb pulse "PZ" "Misc" --kind needs-you     # flash those sessions' rows on the page (needs-you | continue | info)
sb remote on|off|status       # the map on your phone over Tailscale (see "Reaching it")
sb run [claude args...]       # start Claude Code in Switchboard's tmux, so the map/phone can type into it
sb attach NAME                # reattach to an sb-* session; sb sessions lists them
```

### `sb run`: sessions the map can type into
The map can read every session, but it can only type into one that lives in tmux. `sb run` starts Claude Code in
Switchboard's own tmux server (`tmux -L switchboard`, settings in `tmux.conf`) and attaches your terminal to it.
- **Names:** sessions are called `sb-<profile>-<folder>`, e.g. `sb-claude-myrepo`, or `sb-game-…` with
  `CLAUDE_CONFIG_DIR=~/.claude-game`.
- **Environment:** your shell environment is handed over (PATH, `CLAUDE_CONFIG_DIR`, …).
- **Closing:** closing the terminal ends the session. `prefix + d` detaches and keeps it running, and so does
  `SB_KEEP_ON_CLOSE=1`.
- **Run directly:** one-shot commands (`claude -p`, `--version`, `mcp`…) and anything run inside tmux already.
- **Default for `claude`:** add `claude() { sb run "$@"; }` to `~/.zshrc`. `command claude` bypasses it.

Sessions started from the map or the phone (`sb spawn`, or **＋ New**) go to Pocket if it's running, otherwise to this
same tmux, started through your login shell.

### Starting a session from the page or phone (＋ New)
**＋ New** at the top of the session list (the Sessions tab on a phone):
1. Pick a folder. Recent ones come first (where sessions run now, and ones Switchboard started), then every folder in
   `~/Projects`, `~/WebstormProjects` and `~/GameProjects`. Folders in `blocked` are never listed.
2. Give it a name (optional: the folder's name otherwise) and the first prompt, then **Start session**.

It goes through the same guards as `sb spawn` (blocked folders, `maxLiveSpawned`, unique names); a refusal is shown as
it is. By hand: `sb spawn --cwd ~/Projects/x --name "x" "first task"`.

In a folder Claude hasn't opened before, the new session first asks "trust this folder?" and isn't in the list yet.
It shows as a grey ⏳ row at the top of the session list with **Trust it**.
By hand: `sb attach <sb-… name>` (or `tmux -L pocket attach -t pk-…`) and answer it there.

## Using the page
Three columns: the Switchboard chat (drag its right edge to resize), the session list, and the open session.
- **Chat** (left): talk to Switchboard.
  - Replies render as Markdown: headings, lists, tables, code with Copy, links. Message text is always escaped.
  - Tool calls between two messages fold into one line ("▸ 9 tool calls: Bash ×6, get_issue"); click to see each,
    then click one for its details. Bash lines show the call's description, or the real command (no `cd <folder> &&`).
  - Lines about a session carry its coloured chip. Click the chip to open that session.
  - **Waiting on you:** a card at the top for each session that asks you something, with its question and its answer
    buttons (Yes / No, the numbers, a picker's options). A picker with several questions (or "pick any") gets **Answer
    here**: the same form as in the open session, right in the card. **Open** opens the session on the right.
  - **`@name message`** sends the message straight to that session as your own input, not through Switchboard. Names
    are suggested as you type `@…`; a name that matches no session goes to Switchboard unchanged.
- **Session list** (middle): waiting on you first, then unread, working, idle, stale. Each row has the session's icon and
  colour (by folder, `domains`), its status, context size, last activity and what it's doing.
  - **Marks:** a red dot means an unread reply. A yellow **?** means it's waiting on you. A **🤖** (🤖2, 🤖3…) means it
    has agents running (hover for the list). Context over the hand-off limit shows in red.
  - **Names:** automatic names (`<folder>-93`) show as the ticket in the folder (`ABC-12`); the real name is in the tooltip.
  - When Switchboard sends a session something (or points at it with `sb pulse`), its row flashes. The open session
    never changes by itself.
  - **⚙ Settings** sits under the list.
- **The open session** (right): click a row to switch.
  - **Header** (one line): name, state, context size and %, folder, last activity, Rename / End, and **Details** (context
    bar, the command to open it in a terminal) as a dropdown.
- **Reply directly:** the box at the bottom of the open session types into it (tmux sessions only).
- **Chat / Terminal:** the toggle in the open session (or phone sheet) switches to a read-only view of its terminal, colours and
  all (`tmux capture-pane -e`, refreshed every second while it's showing, every 400 ms while a picker or permission
  dialog is on it). Under it, a **Type text** box types your text into its terminal, then Enter. It stays at the bottom unless you scroll up;
  long lines scroll sideways. Remembered per browser. Off for `blocked` folders.
- **Changes:** the third toggle lists the files `git status` shows as changed in its folder (on which branch); tap one
  for its diff against HEAD (new files show as all added), coloured +/-, cut at 200 KB. Read-only, loaded when you
  open it (↻ to reload). Off for `blocked` folders. By hand: `git -C <folder> status` and `git -C <folder> diff HEAD -- <file>`.
- **Chips:** "continue", "yes, go ahead", "commit and push", "run the tests" under every chat. A click types it, like
  the reply box. ✎ adds or removes chips; they're remembered per browser.
- **Quick keys:** **■ Stop** (= Esc), ↑ ↓ ← →, Enter, Space, Tab, ⇧Tab, Esc, Ctrl+C (tap twice), 1–9, pressed in its
  terminal. The row wraps, so every key is on screen on a phone too. Chips, keys and Type text are tmux sessions only,
  and not in `blocked` folders.
- **Session actions** (in the header of the open session or phone sheet; only where they apply):
  - **Rename:** asks for a name and types `/rename <name>` into it (tmux sessions, not `blocked` folders).
  - **End:** after a confirm, closes its tmux session (`tmux kill-session`), so Claude Code exits there; the conversation
    stays resumable. Only `sb-*` (our tmux) and `pk-*` (Pocket's) sessions. By hand: `tmux -L switchboard kill-session -t <name>`.
  - **Take over:** for a session not in tmux (plain `claude` in a terminal). **Close it in its terminal first**: two copies
    writing one conversation mix it up. It's then resumed in our tmux, in its folder and profile, and can be typed into.
    By hand: `cd <folder> && sb run --resume <session id>`. Not in `blocked` folders.
- **Shell and slash commands:** a `!command` or `/command` you send shows as your own 🖥 line with its output folded.

### Voice
- **Mic:** click the mic (or **Ctrl+Space**), talk, click again. The text lands in the box, and **Send when done**
  (on by default) sends it.
- **Hands-free:** the mic stays open. Speech is cut at pauses and transcribed in order. Say **"send it"** (the keyword,
  changeable: default *send it, send to claude, pošalji*) right before a pause to send everything before it.
- **Voice commands**, said on their own: "turn off hands-free", "turn off the mic", "turn on/off send when done",
  "clear that", "language english/bosnian/auto". The phrases can be edited in Settings.
- **Noise gate:** **Calibrate** (talk for 4 s). Sound more than *sensitivity* dB (default 10) quieter than your voice is
  ignored. This helps against TV or office noise, not against someone as loud as you.
- **Stop after silence:** hands-free turns itself off after 5 min without speech (off, or 1–30 min).
- **Language:** *English + Bosnian* (default) only ever returns English or Bosnian/Croatian/Serbian. Anything else is
  transcribed again, and Cyrillic becomes Latin. *English* and *Bosanski* force one.
- **Spelling:** session names and `vocabulary` are hints for Whisper. `corrections` fixes the rest (heard → meant).

### Questions and quick replies
A session gets a **?** (and a card in the chat) when it's waiting on you:
- **Permission dialog** on its screen: the card and the open session show its options, and a click presses that number.
- **Question picker** (AskUserQuestion): the session counts as *needs you* (the ?, the yellow chip, the phone badge) while
  a question is open, and also while a picker is visible on its screen. In the open session or phone sheet the question is a
  yellow card with a **form**: one block per question, a radio button per option (tick boxes for "pick any"), an
  **Other** field for your own words, and one **Submit answers**. Submit presses the keys in the real picker for you
  (↓ to each option, Space for tick boxes, your text on its "Type something" row, Enter, then Submit on the review step)
  and checks its screen after every key. If the screen isn't what it expects (someone already moved in the terminal, a
  key didn't land), it stops at once, leaves the picker as it is, and says **"Couldn't answer automatically, use the
  Terminal tab"**. Once answered, the card turns grey and shows your answer. One single-pick question also gets
  number buttons under the chat (they press that number). Not in `blocked` folders, and only for tmux sessions.
  - **From the Terminal tab:** ↓/↑ move, Enter picks (single) or goes on, Space ticks a box, ←/→ or Tab/⇧Tab switch
    questions; on the "Type something" row put your words in **Type text** (it types them, then Enter). Don't press Esc
    unless you mean it: it cancels the whole picker.
  - **By hand:** `sb attach <name>` (or `pocket attach pk-…` for Pocket's) and answer it in the terminal.
- **A question in its last message:**
  - Buttons by kind: "A, or B?" gives A and B; `Reply "2"` gives 2; numbered choices give their numbers; a yes/no
    question gives Yes / No.
  - Several open questions give a note and **Answer…** instead of buttons.
  - It also counts as waiting when the message asks for your go without ending on a question: a bold question,
    "Decision for you:", "I need your yes before…", "Permission to…".
- **Missed one:** **Mark as waiting on me** gives the ? and Yes / No yourself. It clears when the session next replies.

Nothing is ever sent by itself: a click types the answer into that session's terminal, the same as typing it.
**Other…** opens the reply box. Folders in `blocked` get no quick replies.

### Messages you send
- **States:** **Queued** (pale: the session is mid-turn) → **Sent** → a normal line once the session has read it.
- **Not delivered:** shows the session and the reason, with **Retry** and **Discard**. If the session has ended, it says
  so and has no Retry.
- **Not picked up yet:** not read within 2 min of the session being idle. Also has **Retry** and **Discard**.
- **Hide:** any line can be hidden with × (only on this page; the conversation is untouched).
- **Images:** paste, drop, or 📎. They're scaled down if huge, saved to `~/.switchboard/uploads/switchboard/`, and sent as
  `[image: /path]`. Old ones are deleted after `uploadKeepDays`.
- **Several tabs:** they share the same state and settings. Only one tab owns the hands-free mic (**Use mic here**
  takes it over).

### Settings (⚙)
Hands-free, mic, stop after silence, send when done, language, send keyword, voice commands, noise gate, sensitivity,
calibrate, collapse long messages, show tool activity, density. All are remembered.

## Phone and other computers
- **Phone layout:** tabs at the bottom (Chat, Sessions, Settings). Sessions lists the ones waiting on you first,
  with a badge. A session opens full screen, and Back closes it. Add it to the home screen for a full-screen app;
  `?tab=list` opens a tab directly.
- **Losing the connection:** a red "No connection" pill shows, and requests time out instead of hanging.
  - **Messages:** unsent ones are kept (even across a reload) and go out by themselves when it's back. Each carries an
    id, so a retry after a lost answer isn't typed twice.
  - **Recordings:** ones made offline are transcribed when it's back.

### Reaching it: this Mac only, SSH tunnel, or Tailscale
The server only ever listens on `127.0.0.1`, so there's no firewall prompt and nothing for security tools to flag.
Each way in beyond this Mac is off until you turn it on.

| Option | Default | Setup | Phone mic |
|---|---|---|---|
| This Mac only | on | nothing | n/a |
| SSH tunnel | off | Remote Login on the Mac + `ssh -L` | works |
| Tailscale | off | `remoteLogins` + `sb remote on` | works (HTTPS) |

```bash
# SSH tunnel, from the other computer (any local port works):
ssh -N -L 8790:127.0.0.1:8790 you@your-mac              # then open http://127.0.0.1:8790 there
# The Mac can't accept SSH but can reach the other computer? Run on the Mac instead:
ssh -N -R 8790:127.0.0.1:8790 you@other-computer
# Tailscale: put your login in ~/.switchboard/config.json as "remoteLogins": ["you@example.com"], then
sb remote on        # = tailscale serve --bg --https=8443 http://127.0.0.1:8790 (tailnet only)
sb remote status    # prints the https://<mac>.<tailnet>.ts.net:8443 link
sb remote off       # = tailscale serve --https=8443 off
```
On a phone without Tailscale, an SSH app with port forwarding works too (e.g. Termius: local 8790 → 127.0.0.1:8790).

**Who gets in, in plain words:**
- **Local:** a browser on this Mac or at the end of an SSH tunnel.
- **Tailscale:** a request that comes through Tailscale's own proxy, carrying a Tailscale login listed in
  `remoteLogins`. Public (Funnel) traffic has no login, so it's refused.
- **Other websites:** anything that types into a session must come from the map page itself (same origin, plus a
  custom header). Another website open in your browser can't drive it.
- **Not offered:** listening on the Wi-Fi/LAN address.

## Config: `~/.switchboard/config.json`
Personal values live only here, never in the repo. Start from `config.example.json`.
| Key | What it does |
|---|---|
| `blocked` | Folders Switchboard never starts, types into or answers in (other accounts, client data). Prefix match, `*` = any suffix. |
| `profiles`, `configDirs` | Folder → Claude profile, profile → `CLAUDE_CONFIG_DIR` (e.g. a separate games account). |
| `sendProfiles` | Profiles `sb send` may type into. |
| `maxLiveSpawned` | At most this many live sessions started by Switchboard (default 5). |
| `backend` | Where new sessions start: `auto` (Pocket if running, else own tmux), `tmux`, `pocket`, `bg`. |
| `handoffTokens`, `contextWindow`, `staleHours` | The red ring (default 300k tokens), the % base (1M), when idle becomes stale (4 h). |
| `domains`, `sessionStyles` | Icon and colour by folder, or by session name. |
| `vocabulary`, `corrections` | Whisper spelling hints, and heard → meant fixes. |
| `remoteLogins`, `remotePort` | Tailscale logins allowed in, and the HTTPS port (8443). |
| `uploadsDir`, `uploadKeepDays` | Where attached images go (`~/.switchboard/uploads`), and how long to keep them (7 days; 0 = keep). |
| `port`, `pocketUrl`, `pocketStateDir` | The map's port (8790), and where Pocket is, if you use it. |

**Guards:**
- **Blocked folders:** no starting, typing, quick replies, chips, quick keys or terminal view there.
- **Session cap:** at most `maxLiveSpawned` sessions started by Switchboard.
- **Name clashes:** refused.
- **Many new sessions:** more than 3 from one message is listed first and needs your OK.
- **Nothing destructive:** Switchboard never ends sessions or does anything destructive on its own.

## The dispatcher
Its rules are in `dispatcher/CLAUDE.md`, symlinked into `~/.switchboard/dispatcher/`. It runs on Sonnet
(`dispatcher/settings.json`), which pre-allows only `sb ls`, `sb spawn`, `sb send`, `sb pulse` and reading the handoff
folder.
- **Routing:** each idea in a message goes to its session (`SendMessage`, or `sb send` for other profiles) or becomes a
  new one (`sb spawn`).
- **Approvals:** come only from you. A message passed along from another session doesn't count.
- **Handoffs:** sessions over `handoffTokens` get a red ring. "hand off X" makes X write
  `~/.switchboard/handoffs/<name>-<date>.md`, then a fresh session continues from that note.

## Tests
```bash
npm test               # everything (about 2 minutes)
npm run test:unit      # Node only, a few seconds
npm run test:browser   # the map in headless Chrome
```
- **Setup:** both suites build a fake home folder with made-up sessions, and run their own tmux server. They never
  read or type into your real ones.
- **Unit tests:** session parsing, context and states, asks and quick replies, the chat feed (tool rows, question
  cards, shell lines), the question picker (real screens parsed; every answer flow and mismatch against a scripted picker,
  `test/fake-picker.ts`), the guards, access rules, typing once, Pocket names, spawning in tmux, quick keys, the terminal
  view (refused for blocked folders), the ＋ New folder list and its guards, rename / end / take over and their guards, changed files and diffs (only listed paths), voice language rules.
- **Two checkouts at once:** `SWITCHBOARD_TEST_PORT=8817 npm test` moves the browser test server off port 8797.
- **Browser tests:** the page itself: delivery states, markdown safety, popups, the terminal view, quick keys and chips,
  settings, hands-free with synthetic speech and real Whisper, noise gate, scroll, two tabs, the phone layout, losing
  the connection, and icons. The voice checks need macOS `say`, whisper.cpp and the model. The test server gets a tmux
  wrapper on PATH that never reaches the real `tmux -L pocket`.

## Docs
- `docs/mobile.md`: the plan for running everything from the phone and replacing Pocket Sessions, with a
  feature-by-feature checklist.
- `CLAUDE.md`: notes for developing Switchboard (how it works, pitfalls).

## Known limits / not tested yet
- **Real phones:** nothing on a real phone yet, Pixel or iPhone: touch, mic, home-screen install, the keyboard, losing
  signal, an SSH app.
- **Question picker form:** its key sequence was worked out on a real picker (Claude Code 2.1.300, private tmux), and the
  tests drive a scripted copy of it; the form itself hasn't answered a live session's picker yet. A new Claude Code that
  draws the picker differently makes it refuse (Terminal tab), not guess.
- **Read-only sessions:** sessions not in tmux (started with plain `claude`) can be read but not typed into. Use `sb run`,
  or **Take over** (resumes it with `claude --resume`, not a fork: close the original first). Not tried live yet.
- **Terminal view:** read-only, and doesn't resize the pane to the phone. Changes shows uncommitted work only (against
  HEAD), not what a branch committed since main.
- **Detection is a heuristic:** a session that asks in an unusual way may not get the ?. Use **Mark as waiting on me**.

## License
MIT, see [LICENSE](LICENSE). Nothing third-party is bundled: whisper.cpp and the Whisper model (both MIT) are installed
separately.
