import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFixture, makeRepo } from "./fixtures.ts";
import { newPicker } from "./fake-picker.ts";

/**
 * Browser tests: a test map server on its own port, with fake sessions (no real ones are read or typed
 * into), opened in headless Chrome. The page test/web/test.html runs the checks and posts the results.
 * Needs: Google Chrome; for the voice checks macOS `say`, whisper.cpp and the model (else they fail).
 */

const PORT = Number(process.env.SWITCHBOARD_TEST_PORT) || 8797; // another port when two checkouts run their tests at once
const REAL_HOME = os.homedir();
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const repo = path.join(import.meta.dirname, "..");
const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sb-browser-")));
const fx = makeFixture(path.join(tmp, "home"));
makeRepo(fx.folders.b); // Beta's folder: one change of each kind for the Changes view
const fixtures = path.join(tmp, "fixtures");
const results = path.join(tmp, "results.json");
mkdirSync(fixtures);

// Synthetic speech: 16 kHz mono PCM, stored as base64 for the test page.
function speech() {
  const pcm = (text: string, gainDb = 0) => {
    const file = path.join(fixtures, "s.wav");
    execFileSync("say", ["-o", file, "--data-format=LEI16@16000", text]);
    const data = readFileSync(file).subarray(44); // skip the WAV header (`say` writes a plain 44-byte one)
    const out = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
    const f = 10 ** (gainDb / 20);
    return Int16Array.from(out, (x) => Math.round(x * f));
  };
  const silence = (s: number) => new Int16Array(Math.round(16000 * s));
  const join = (...parts: Int16Array[]) => {
    const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0; for (const p of parts) { all.set(p, at); at += p.length; }
    return Buffer.from(all.buffer).toString("base64");
  };
  const cal = pcm("Testing one two three, calibrating.");
  writeFileSync(path.join(fixtures, "hf.b64"), join(
    pcm("Ask PS Tokens if the refresh test is still flaky."), silence(1.3), pcm("Send it."), silence(1.5),
    pcm("Tell Misc to check the logs."), silence(1.3), pcm("Send it."), silence(1.5)));
  writeFileSync(path.join(fixtures, "gate.b64"), join(
    cal, silence(Math.max(0, 4.6 - cal.length / 16000) + 0.3),
    pcm("Breaking news tonight on channel five, the weather is cold and windy.", -12), silence(1.5),
    pcm("Ask PS Tokens about the flaky test."), silence(1.3), pcm("Send it."), silence(1.5),
    pcm("Turn off send when done."), silence(1.5)));
  // Language checks: a full WAV each (header included), posted to /api/transcribe in auto mode.
  const wav = (voice: string | undefined, text: string, name: string) => {
    execFileSync("say", [...(voice ? ["-v", voice] : []), "-o", path.join(fixtures, name), "--data-format=LEI16@16000", text]);
  };
  wav(undefined, "Ask Mirza if the pilot work tree is ready.", "lang-en.wav");
  wav("Lana", "Pitaj Mirzu da li je pilot spreman za sutra.", "lang-bs.wav");
  wav("Milena", "Привет, проверь пожалуйста тесты сегодня.", "lang-ru.wav");
}

if (!existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME} (set CHROME=...). Skipping browser tests.`);
  process.exit(1);
}
try { speech(); } catch (e) { console.error("macOS `say` unavailable: voice checks will fail.", (e as Error).message); }

// The fixture's sessions are pk-* (Pocket's tmux). The test server gets a tmux wrapper on PATH that never reaches the
// real `tmux -L pocket`: it answers capture-pane for pk-claude-beta with a coloured test screen (a new "tick" line each
// time), logs key presses, and fails anything else there. Every other socket (the suite's own) goes to the real tmux.
const realTmux = execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim();
const fakeBin = path.join(tmp, "bin");
mkdirSync(fakeBin);
writeFileSync(path.join(fixtures, "screen.txt"), [
  "\x1b[1;32m✔ tests pass\x1b[0m and \x1b[38;5;196mred 256\x1b[0m and \x1b[38;2;10;200;30mtrue colour\x1b[0m",
  "<script>window.__pwned = 1</script> <img src=x onerror=\"window.__pwned=1\"> & \x1b]0;title\x07\x1b[?25l done",
  "a very long line: " + "x".repeat(400),
  ...Array.from({ length: 60 }, (_, i) => `line ${i}`),
].join("\n") + "\n");
// pk-claude-repo-ABC-12 (asking "Ship it now?") is the scripted picker from test/fake-picker.ts: the question form drives it.
const pickerState = path.join(tmp, "picker.json");
writeFileSync(pickerState, JSON.stringify(newPicker([{ question: "Ship it now?", header: "Ship", multiSelect: false, options: [{ label: "Yes, ship" }, { label: "Wait for review" }] }])));
writeFileSync(path.join(fakeBin, "tmux"), `#!/bin/sh
if [ "$1" = "-L" ] && [ "$2" = "pocket" ]; then
  case "$*" in
    *=pk-claude-repo-ABC-12:*) exec "${process.execPath}" --disable-warning=ExperimentalWarning "${path.join(repo, "test", "fake-picker.ts")}" "$@" ;;
    *capture-pane*=pk-claude-beta:*) n=$(cat "${tmp}/ticks" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${tmp}/ticks"; cat "${fixtures}/screen.txt"; echo "tick $n"; exit 0 ;;
    *send-keys*|*kill-session*) echo "$@" >> "${tmp}/keys.log"; exit 0 ;;
  esac
  exit 1
fi
exec "${realTmux}" "$@"
`, { mode: 0o755 });

const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "src", "cli.ts"), "map", "--port", String(PORT)], {
  env: {
    ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HOME: fx.home, SWITCHBOARD_STATE_DIR: fx.state, SWITCHBOARD_TEST: "1", SWITCHBOARD_TMUX_SOCKET: `sb-browser-${process.pid}`,
    SWITCHBOARD_TEST_RESULTS: results, SWITCHBOARD_TEST_FIXTURES: fixtures, FAKE_PICKER_STATE: pickerState,
    SWITCHBOARD_WHISPER_MODEL: path.join(REAL_HOME, ".switchboard", "models", "ggml-large-v3-turbo-q5_0.bin"),
  },
  stdio: ["ignore", "ignore", "inherit"],
});
let chrome: ReturnType<typeof spawn> | undefined;
const cleanup = () => {
  chrome?.kill(); server.kill(); rmSync(tmp, { recursive: true, force: true });
  try { execFileSync("tmux", ["-L", `sb-browser-${process.pid}`, "kill-server"], { stdio: "ignore" }); } catch {}
};

try {
  for (let i = 0; i < 40; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/api/state`).then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${path.join(tmp, "chrome")}`, "--no-first-run", "--window-size=1500,2000",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `http://127.0.0.1:${PORT}/test/test.html`], { stdio: "ignore" });
  // A command-line client (no Origin header, like the dispatcher's shell) must not be able to type into sessions.
  const cli = await fetch(`http://127.0.0.1:${PORT}/api/session/say`, { method: "POST", headers: { "content-type": "application/json", "x-switchboard": "1" }, body: JSON.stringify({ sessionId: "x", text: "yes", quick: true }) });
  // Nor start, end, rename or take over sessions.
  const cliActions = await Promise.all(["/api/spawn", "/api/session/end", "/api/session/rename", "/api/session/takeover"].map((p) =>
    fetch(`http://127.0.0.1:${PORT}${p}`, { method: "POST", headers: { "content-type": "application/json", "x-switchboard": "1" }, body: JSON.stringify({ sessionId: "beta-0000-0000", cwd: "~/Projects/alpha", prompt: "p", name: "x" }) }).then((r) => r.status)));
  const cliOk = cli.status === 403 && cliActions.every((s) => s === 403);
  console.log(`${cliOk ? "✔" : "✖"} quick replies and session actions refuse command-line callers (HTTP ${cli.status}, ${cliActions.join(" ")})`);
  // Auto language = English + Bosnian only: never Russian/Bulgarian, never Cyrillic; corrections applied.
  const heard = async (file: string) => {
    if (!existsSync(path.join(fixtures, file))) return `(no ${file}: macOS say voice missing)`;
    const r = await fetch(`http://127.0.0.1:${PORT}/api/transcribe?lang=auto`, { method: "POST", headers: { "content-type": "audio/wav", "x-switchboard": "1" }, body: readFileSync(path.join(fixtures, file)) });
    return ((await r.json()) as { text?: string; error?: string }).text ?? "";
  };
  const langChecks: [string, boolean, string][] = [];
  const en = await heard("lang-en.wav"), bs = await heard("lang-bs.wav"), ru = await heard("lang-ru.wav");
  langChecks.push(["voice: English stays English, corrections applied (work tree → worktree)", /mirza/i.test(en) && /worktree/.test(en), en]);
  langChecks.push(["voice: Bosnian stays Bosnian, in Latin letters", /pitaj/i.test(bs) && !/[\u0400-\u04FF]/.test(bs), bs]);
  langChecks.push(["voice: Russian-sounding audio is re-transcribed, never Cyrillic", ru.length > 0 && !/[\u0400-\u04FF]/.test(ru), ru]);
  for (const [name, ok, text] of langChecks) console.log(`${ok ? "✔" : "✖"} ${name}${ok ? "" : `\n    ${JSON.stringify(text)}`}`);
  const langFailed = langChecks.filter((c) => !c[1]).length;
  const deadline = Date.now() + 360_000;
  while (!existsSync(results) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  if (!existsSync(results)) throw new Error("timed out waiting for the browser tests");
  const rows: { name: string; ok: boolean; detail: unknown }[] = JSON.parse(readFileSync(results, "utf8"));
  for (const r of rows) console.log(`${r.ok ? "✔" : "✖"} ${r.name}${r.ok ? "" : `\n    ${JSON.stringify(r.detail)}`}`);
  // The form's one real answer reached the picker as ↓ Enter; its refused second try pressed nothing.
  const picker = JSON.parse(readFileSync(pickerState, "utf8"));
  const pickerOk = JSON.stringify(picker.keys) === JSON.stringify(["Down", "Enter"]) && picker.closed === "submitted";
  console.log(`${pickerOk ? "✔" : "✖"} question form: keys in the picker were exactly ↓ Enter, none after the refusal${pickerOk ? "" : `\n    ${JSON.stringify(picker.keys)}`}`);
  const failed = rows.filter((r) => !r.ok).length + (cliOk ? 0 : 1) + langFailed + (pickerOk ? 0 : 1);
  console.log(`\nbrowser: ${rows.length + 5 - failed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error((e as Error).message);
  cleanup();
  process.exit(1);
}
