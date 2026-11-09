# Switchboard

**One page for all your Claude Code sessions. Talk to one, and it passes your words to the rest.**

Running five Claude Code sessions in five terminals gets messy fast: which one is waiting on you, which one finished,
which one you meant to tell something. Switchboard puts them all on one page in your browser:

- **Every session at a glance:** what it's doing, whether it's waiting on you, and how full its context is.
- **Answer questions with a click:** when a session asks you something, a card shows up with the answer buttons.
- **One chat for everything:** say "tell the API session to add tests, and start a new one for the docs" and
  Switchboard sends each part to the right place.
- **Read and reply to any session** without hunting for its terminal: its chat, its live terminal, and its changed files.
- **Optional extras:** talk instead of typing (speech stays on your Mac), and open the same page on your phone.

It runs on your Mac only. Nothing to build, no packages to install, and nothing is reachable from outside unless you
turn it on.

## Install (2 minutes)

You need a Mac with:
- **Claude Code**, installed and logged in (`claude --version`)
- **Node.js 26 or newer** (`node -v`; install or update with `brew install node`)
- **tmux** (`brew install tmux`)

Then:
```bash
git clone https://github.com/vedran24r/switchboard.git ~/switchboard
mkdir -p ~/.local/bin && ln -s ~/switchboard/bin/sb ~/.local/bin/sb
sb up
```
`sb up` opens http://127.0.0.1:8790 in your browser. The first time, click **Start Switchboard**, then **Trust it**
(Claude asks once whether it may work in Switchboard's own folder).

`sb: command not found`? Your shell doesn't look in `~/.local/bin` yet. Add `export PATH="$HOME/.local/bin:$PATH"`
to `~/.zshrc` and open a new terminal.

**Keep it running** (optional): this starts the page at login and restarts it if it stops.
```bash
~/switchboard/scripts/install-launchd.sh
```

## Use it

1. **Start your sessions with `sb run`** instead of `claude`. They work the same, but now the page can type into them
   too. (Sessions started with plain `claude` still show up, read-only.) To make it the default, add
   `claude() { sb run "$@"; }` to `~/.zshrc`.
2. **Open the page.** Left: your chat with Switchboard. Middle: every session. Right: the one you clicked.
3. **Watch for the yellow ?** It means a session is waiting on you. Its question also shows as a card at the top of the
   chat: click an answer, or **Open** to go to it.
4. **Talk to Switchboard** in the chat box to send work to sessions, or start new ones. Or type `@name message` to
   send something straight to one session.
5. **＋ New** above the list starts a new session in any folder.

Nothing is sent without you: every click types into a session exactly what you'd have typed yourself.

## Optional extras

- **Voice:** install whisper.cpp and one model (about 550 MB), then click the mic or press Ctrl+Space. Speech is
  turned into text on your Mac. There's also a hands-free mode: say "send it" to send.
  [Setup](docs/guide.md#voice).
- **Phone:** open the same page on your phone over [Tailscale](https://tailscale.com) (`sb remote on`) or an SSH
  tunnel. [How](docs/guide.md#reaching-it-this-mac-only-ssh-tunnel-or-tailscale).
- **Your own settings:** copy `config.example.json` to `~/.switchboard/config.json` to block folders Switchboard must
  never touch, give folders their own icon and colour, and more. Everything works without it.
  [All options](docs/guide.md#config-switchboardconfigjson).

## Handy commands

```bash
sb up            # start everything and open the page
sb ls            # list every live session in the terminal
sb run           # start Claude Code where the page can reach it
sb attach NAME   # jump into a session's terminal
sb help          # everything else
```

## Safe by default

- The page only listens on your own Mac (`127.0.0.1`). Other websites can't use it.
- Folders you list as `blocked` are never touched: no typing, no answering, no starting sessions there.
- Switchboard never ends a session or does anything destructive by itself, and at most 5 sessions it started can run at
  once.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/ai.switchboard.map; rm -f ~/Library/LaunchAgents/ai.switchboard.map.plist
rm ~/.local/bin/sb && rm -rf ~/switchboard ~/.switchboard
```

## More

- **[The full guide](docs/guide.md):** every feature, setting and command in detail.
- **Problems?** The page's log is `~/.switchboard/map.log`. Restart it with
  `launchctl kickstart -k gui/$(id -u)/ai.switchboard.map`.
- **Tests:** `npm test` (needs Google Chrome for the browser part).
- **Contributing:** [CLAUDE.md](CLAUDE.md) explains how it works inside.

MIT licensed, see [LICENSE](LICENSE).
