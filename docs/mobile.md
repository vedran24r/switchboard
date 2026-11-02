# Switchboard on the phone: plan

Goal: one place for everything. Switchboard on the phone does what Pocket Sessions does today, and Pocket can then
be retired. Reached over Tailscale only (HTTPS via `tailscale serve`), no public exposure, no account.

## Phase 1: reach it and use it on a phone (done, 2026-10-23)
- `sb remote on|off|status` publishes the map on `https://<mac>.<tailnet>.ts.net:8443`, tailnet only.
- Access: loopback socket + `*.ts.net` host + `Tailscale-User-Login` in `remoteLogins` (`src/access.ts`).
- Phone layout (≤700px): tabs Chat / Sessions / Map / Settings, session list sorted waiting-on-you first, badge
  (also the app icon badge where the browser supports it), sessions open full screen with quick replies and the
  reply box open, the phone's Back closes them. Touch never triggers hover popups, and routes don't open sheets by themselves.
- Installable: web manifest + icon ("Add to home screen"). Voice works because the page is HTTPS (mic needs it).

## Phase 2: the terminal, from the phone
Pocket's most used feature after chat. Switchboard already captures panes for the dispatcher.
- **Terminal tab in a session sheet:** read-only render of `tmux capture-pane -e`. Stream it with SSE (send only on
  change, about 250 ms), and render ANSI colours with a small converter rather than xterm.js, to keep zero dependencies.
  Built (2026-10-29) as a 1 s poll of `GET /api/session/screen` while the view shows; SSE only if that feels slow.
- **Quick keys:** Esc, Enter, arrows, Tab, Shift+Tab, Ctrl+C, 1–5, plus a Stop button (Esc). These extend `pressKey`.
- **Reliable typing:**
  - Port Pocket's chunked `send-keys` and its Enter retry (it checks the text left the input box).
  - Send with an idempotency id.
  - Keep a localStorage outbox so a send made with a weak signal isn't lost.
- **Fit to phone (optional):** resize the tmux window to the phone's columns while it's watched, and restore it after.
  This is Pocket's `fitToPhone`. Skip it unless the read-only render is too cramped.

## Phase 3: replace Pocket
- **Own wrapper:** `sb run` replaces `pocket run`. It is a shell `claude()` wrapper that starts every interactive
  session in `tmux -L switchboard`, so every session is typeable. Sessions started outside it stay read-only.
- **New session from the phone:** pick a folder (recent folders and profiles) and a name, then go through `spawnSession`.
  Its guards stay: blocked folders, max live sessions.
- **More from Pocket:** port the "Changes" tab (git status plus a per-file diff), image upload from the phone
  (already there), and End session (needs a confirm).
- **Switchover** (only after every row of the checklist below is ✅ on both phones):
  - Move `sb remote` to serve on 443 `/`, which is Pocket's slot today.
  - Switch `backend` to own tmux.
  - Uninstall Pocket's launchd job and shell wrapper.
  - Keep the `pocket-sessions` repo up and working for other people who use it; only Vedran's own setup moves.

## Phase 4: ready for other people (replaces Pocket in team setup kits)
Team setup kits install Pocket by piping a public `bootstrap.sh` from curl, check it with `launchctl list | grep ai.pocket-sessions`,
and put a "scan the QR code" step after setup. Switchboard needs the same pieces before it can take that slot:
- **Multi-account profile folders:** some tools give each Claude account its own `CLAUDE_CONFIG_DIR` and pick it per
  project folder with direnv (`.envrc`: `export CLAUDE_CONFIG_DIR="$HOME/.claude-plex/profiles/<name>"`).
  - Discovery: also read `~/.claude-plex/profiles/*/sessions` (or `$CLAUDE_PLEX_HOME`), with the folder name as the profile.
    Today only `~/.claude*` is scanned, so those sessions would be missing from the map.
  - Spawn: when no `profiles` rule matches, pick the account from the nearest `.envrc` that sets `CLAUDE_CONFIG_DIR`
    (parsed, never executed), else the tool's `default` file.
  - `sb run` passes the caller's environment into tmux, the way Pocket does, so direnv's choice survives.
- **Install:**
  - A public repo with a license.
  - `scripts/bootstrap.sh`: clone to `~/.switchboard/app`, link `sb`, install launchd, add the `claude()` → `sb run` wrapper.
  - Voice is optional (whisper.cpp + a ~550 MB model), and the installer asks before downloading it.
- **Phone link:** `sb remote on` adds the user's own Tailscale login to `remoteLogins` by itself and prints a QR code
  (Pocket uses `qrcode-terminal`; a dependency-free QR encoder is ~200 lines, or print the link only).
- **Status check:** `launchctl list | grep -q ai.switchboard.map`.
- **Defaults stay neutral:** no personal domains or vocabulary in `DEFAULTS`. The dispatcher's rules must make sense for anyone.

## Not planned
- **Push notifications:** Vedran doesn't want them (2026-10-23). The Sessions badge and the "?" marks cover "waiting on you".
  Note that Pocket's push stops too when Pocket is retired.

## What stays the same
- **Server:** the server only ever listens on 127.0.0.1.
- **Blocked folders:** no typing, quick replies or terminal view in blocked (client) folders. The terminal view
  counts as reading the pane, so it's off there too.
- **No build step:** plain HTML, CSS and JS, and Node runs the `.ts` files.

## Phones: Pixel (Android Chrome) and iPhone (Safari)
Both are in scope. iPhone-specific handling so far:
- The mic resumes a suspended AudioContext after the tap. Otherwise iOS records silence.
- The page is sized to the visible area above the keyboard (`visualViewport`, `fitKeyboard`). The tabs hide while you type.
- 16px inputs (iOS zooms in on anything smaller), safe-area padding, and a 180px PNG `apple-touch-icon`.
- Install: Safari → Share → Add to Home Screen. The app badge only works from the home-screen app (iOS 16.4+).
The iPhone needs the Tailscale app, logged in to the same tailnet as the Mac. There is no iOS simulator on this Mac,
so iPhone checks are done by hand.

## Retirement checklist: Pocket feature → Switchboard
Pocket can go when every row is ✅ on both phones. "Built" means there is code with automated checks. The phone
columns are filled in by hand after trying it for real.

| Pocket feature | Switchboard | Built | Pixel | iPhone |
|---|---|---|---|---|
| Open from the phone over Tailscale (HTTPS) | `sb remote on`, :8443 | ✅ | ☐ | ☐ |
| Install to home screen, app icon | manifest + PNG icons | ✅ | ☐ | ☐ |
| Session list, waiting-on-you first, badge | Sessions tab | ✅ | ☐ | ☐ |
| Read a session's chat | session sheet | ✅ | ☐ | ☐ |
| Type a reply into a session | reply box (tmux sessions only) | ✅ | ☐ | ☐ |
| Answer a permission dialog (1/2/3, y/n) | quick replies on "?" | ✅ | ☐ | ☐ |
| Dictate | mic → Whisper on the Mac | ✅ | ☐ | ☐ |
| Attach a photo / screenshot | 📎 in chat and sheets | ✅ | ☐ | ☐ |
| Keyboard doesn't cover the input | `fitKeyboard` | ✅ (needs a real phone) | ☐ | ☐ |
| Standing quick chips ("continue", "commit and push"…) | chips in the session sheet | ✅ | ☐ | ☐ |
| Quick keys: Esc, Enter, arrows, Tab, Ctrl+C; Stop | keys bar in the session sheet | ✅ | ☐ | ☐ |
| Live terminal view (read-only) | Chat / Terminal toggle, polled 1 s | ✅ | ☐ | ☐ |
| Terminal touch: scroll, text size | scrolls by touch; A− / A+ in the Terminal view (pinch would zoom the whole page) | ✅ | ☐ | ☐ |
| Sends survive a weak signal (outbox, no doubles) | outbox `sb-outbox` + server dedupe by message id (`typeOnce`) | ✅ | ☐ | ☐ |
| Start a new session (folder + name) | ＋ New in Sessions (and on the map): folder list, name, first prompt | ✅ | ☐ | ☐ |
| Every new `claude` typeable from the phone | `sb run` wrapper (in `~/.zshrc` at the switchover) | ✅ | ☐ | ☐ |
| Take over a read-only session ("continue on phone") | Take over in the sheet: `claude --resume` in our tmux | ✅ | ☐ | ☐ |
| Rename / end a session | Rename (types /rename) and End (sb-*/pk-* only, confirm) in the sheet | ✅ | ☐ | ☐ |
| Changed files + diff | Changes view in the sheet (git status, per-file diff vs HEAD) | ✅ | ☐ | ☐ |
| Push notifications | not wanted | n/a | | |

Switchboard extras that Pocket doesn't have: the dispatcher, the map, hands-free voice, and the context and hand-off
warnings.

## Open questions for Vedran
1. **Going public:** phase 4 needs a public repo and a license. Is that OK, and when: right away, or after his own switchover?
