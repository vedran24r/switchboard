import { execFileSync } from "node:child_process";
import { parsePicker, type PickerScreen } from "./asks.ts";
import { isBlocked, loadConfig, type Config } from "./config.ts";
import { GoneError, isDispatcher } from "./dispatcher.ts";
import { listSessions, openQuestion } from "./sessions.ts";
import { socketFor } from "./tmux.ts";

/**
 * Answering an AskUserQuestion from the map's form by pressing keys in Claude Code's real picker. How the picker
 * behaves (2.1.300, studied 2026-10-30): the cursor starts on option 1 of each question; ↓ moves it. Single-select:
 * Enter picks the highlighted option and moves on (to the next question, the review step, or, with only one question,
 * submits). The last row "N. Type something." takes typed text right there (no Enter first). MultiSelect: Space toggles a
 * box, typing on the Type something row ticks it, and a "Next"/"Submit" row below goes on. The review step lists
 * "→ answer" per question; Enter on "1. Submit answers" sends them. Esc cancels the whole picker, so it's never pressed.
 *
 * Every key is followed by a `capture-pane -p` check that the picker shows exactly what it should (the question, every
 * option, the boxes, the highlighted row). On any surprise it stops right there and leaves the picker as it is.
 */

export interface PickerAnswer { picks: number[]; other?: string }
interface Question { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }
/** What the driver needs from tmux: the screen now, and one send-keys. Tests pass a scripted picker instead. */
export interface PickerIO { screen(): string; press(args: string[]): void }

export const MISMATCH = "Couldn't answer automatically, use the Terminal tab";
const refuse = (message: string, status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
/** Screen text vs. what it should say: equal, or the start of it (long text is cut with "…"). Spaces don't count: wrapping
 * may break a line inside a word or at a space, and joined lines can't tell which. */
export function same(screen: string | undefined, want: string): boolean {
  const a = norm(screen ?? "").replace(/…$/, "").replace(/ /g, ""), b = norm(want).replace(/ /g, "");
  return !!a && (a === b || (b.startsWith(a) && a.length >= Math.min(b.length, 10)));
}

/** The visible end of a question whose top scrolled off the pane: the question ends with it (spaces don't count). */
export function sameEnd(screen: string, want: string): boolean {
  const a = norm(screen).replace(/ /g, ""), b = norm(want).replace(/ /g, "");
  return !!a && b.endsWith(a) && a.length >= Math.min(b.length, 10);
}

/** The answers as the form sent them, checked against the questions (400 for anything off). Text: no control characters. */
export function checkAnswers(questions: Question[], answers: unknown): PickerAnswer[] {
  const bad = (why: string) => refuse(why, 400);
  if (!Array.isArray(answers) || answers.length !== questions.length) throw bad("One answer per question, please");
  return questions.map((q, i) => {
    const a: any = answers[i] ?? {};
    const n = Array.isArray(q.options) ? q.options.length : 0;
    const picks = Array.isArray(a.picks) ? [...new Set(a.picks)] : [];
    if (!picks.every((p) => Number.isInteger(p) && (p as number) >= 0 && (p as number) < n)) throw bad("That option isn't in the question");
    const other = a.other == null ? undefined : String(a.other).replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 500);
    if (a.other != null && !other) throw bad("Type your own answer, or untick Other");
    const count = picks.length + (other ? 1 : 0);
    if (!count) throw bad(`Answer “${q.header || q.question}” first`);
    if (!q.multiSelect && count > 1) throw bad(`“${q.header || q.question}” takes one answer`);
    return { picks: (picks as number[]).sort((x, y) => x - y), ...(other ? { other } : {}) };
  });
}

/** What the review step should list for one question: the label, or the picked labels in option order then your own text. */
const inOrder = (picks: number[]) => [...picks].sort((x, y) => x - y);
export const answerText = (q: Question, a: PickerAnswer) => [...inOrder(a.picks).map((p) => q.options[p].label), ...(a.other ? [a.other] : [])].join(", ");

/** The picker for question `qi` as it should look: labels (the last is your typed text once typed), boxes, highlighted row. */
interface Want { qi: number; typed?: string; checked: boolean[]; cursor: number }
function looksRight(p: PickerScreen | undefined, qs: Question[], w: Want): boolean {
  const q = qs[w.qi], n = q.options.length;
  if (!p || p.review) return false;
  if (p.cut) {
    // Top off screen: no tab bar to check. What shows of the question must be its end; with none of it showing, the
    // labels must tell this question apart from every other one in the picker.
    const labels = (x: Question) => JSON.stringify(x.options.map((o) => norm(o.label)));
    if (p.title ? !sameEnd(p.title, q.question) : qs.some((x, i) => i !== w.qi && labels(x) === labels(q))) return false;
  } else {
    if (!same(p.title, q.question) || p.tabs.length !== qs.length) return false;
    // Tabs before this one are answered, the ones after aren't (this one's mark changes as boxes are ticked).
    if (p.tabs.some((t, i) => (i < w.qi && !t.done) || (i > w.qi && t.done))) return false;
    if (q.header && !same(p.tabs[w.qi].label, q.header)) return false;
  }
  for (let j = 0; j <= n; j++) {
    const row = p.rows.find((r) => r.n === j + 1);
    if (!row) return false;
    const label = j < n ? same(row.label, q.options[j].label) : w.typed ? same(row.label, w.typed) : /^Type something\.?$/.test(row.label);
    if (!label || (q.multiSelect ? row.checked !== w.checked[j] : row.checked !== undefined)) return false;
  }
  const at = p.rows.filter((r) => r.cursor);
  if (at.length !== 1) return false;
  if (w.cursor <= n + 1) return at[0].n === w.cursor;
  return at[0].n === undefined && at[0].label === (w.qi === qs.length - 1 ? "Submit" : "Next");
}

export async function drivePicker(io: PickerIO, qs: Question[], answers: PickerAnswer[], { timeoutMs = 3000, pollMs = 50 } = {}): Promise<string[]> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Wait until the screen shows `ok`, else stop here (nothing more is pressed). */
  const until = async (what: string, ok: (p: PickerScreen | undefined) => boolean) => {
    for (const end = Date.now() + timeoutMs; ;) {
      if (ok(parsePicker(io.screen()))) return;
      if (Date.now() > end) throw refuse(MISMATCH, 409, { picker: true, detail: `expected ${what}` });
      await sleep(pollMs);
    }
  };
  const texts = qs.map((q, i) => answerText(q, answers[i]));
  let w: Want = { qi: 0, checked: qs[0].options.map(() => false).concat(false), cursor: 1 };
  const step = async (args: string[], next: Want, what: string) => { io.press(args); w = next; await until(what, (p) => looksRight(p, qs, w)); };
  await until(`question 1 (“${qs[0].header || qs[0].question}”) untouched, option 1 highlighted`, (p) => looksRight(p, qs, w));
  for (const [qi, q] of qs.entries()) {
    const a = answers[qi], n = q.options.length, name = q.header || q.question;
    const moveTo = async (row: number) => {
      while (w.cursor < row) await step(["Down"], { ...w, cursor: w.cursor + 1 }, `row ${w.cursor + 1} highlighted on “${name}”`);
    };
    const typeOther = async () => {
      await moveTo(n + 1);
      const checked = [...w.checked]; if (q.multiSelect) checked[n] = true;
      await step(["-l", "--", a.other!], { ...w, typed: a.other, checked }, `“${a.other}” typed on “${name}”`);
    };
    if (q.multiSelect) {
      for (const pick of inOrder(a.picks)) { // the cursor only ever moves down
        await moveTo(pick + 1);
        const checked = [...w.checked]; checked[pick] = true;
        await step(["Space"], { ...w, checked }, `option ${pick + 1} ticked on “${name}”`);
      }
      if (a.other) await typeOther();
      await moveTo(n + 2);
    } else if (a.other) await typeOther();
    else await moveTo(a.picks[0] + 1);
    io.press(["Enter"]);
    if (qi < qs.length - 1) {
      w = { qi: qi + 1, checked: qs[qi + 1].options.map(() => false).concat(false), cursor: 1 };
      await until(`question ${qi + 2} (“${qs[qi + 1].header || qs[qi + 1].question}”)`, (p) => looksRight(p, qs, w));
    }
  }
  // One single-select question is sent by its Enter; otherwise check the review step, then Submit.
  if (qs.length > 1 || qs[0].multiSelect) {
    // A review step taller than the pane shows only its last answers (the top, with any "not answered" warning, is off
    // screen); they must be the end of ours. Every answer was already checked on its own question.
    await until("the review step with your answers", (p) => !!p?.review && !p.incomplete &&
      (p.cut ? p.answers.length > 0 && p.answers.length <= qs.length : p.answers.length === qs.length) &&
      p.answers.every((x, i) => same(x, texts[qs.length - p.answers.length + i])) && p.rows.filter((r) => r.cursor).length === 1 && !!p.rows.find((r) => r.cursor && r.n === 1 && r.label === "Submit answers"));
    io.press(["Enter"]);
  }
  try { await until("the picker to close", (p) => !p); }
  catch { throw refuse("Sent the answers, but couldn't see the picker close: check the Terminal tab", 409, { picker: true }); }
  return texts;
}

const answering = new Set<string>();

/**
 * POST /api/session/answer: the form's answers for the question this session is asking now. `questionTexts` must be
 * that question set (else it moved on). Refused for blocked folders and sessions outside tmux before tmux is touched.
 */
export async function answerPicker(sessionId: string, questionTexts: unknown, answers: unknown, config: Config = loadConfig(), opts: { timeoutMs?: number; pollMs?: number } = {}) {
  const s = listSessions(config).find((x) => x.sessionId === sessionId);
  if (!s) throw new GoneError("That session isn't running any more");
  if (isDispatcher(s)) throw refuse("Not for Switchboard itself", 403);
  if (isBlocked(s.cwd, config)) throw refuse("Answering from the map is off for this folder (blocked). Answer it in its own terminal.", 403, { blocked: true });
  if (!s.tmux) throw refuse(`${s.name} doesn't run in tmux, so its picker can't be answered from here. Open it in a terminal.`, 409);
  const qs: Question[] = openQuestion(s.transcript)?.questions;
  if (!Array.isArray(qs) || !qs.length) throw refuse("It isn't asking anything right now", 409);
  if (!Array.isArray(questionTexts) || questionTexts.length !== qs.length || qs.some((q, i) => q.question !== questionTexts[i])) throw refuse("That question isn't waiting any more", 409);
  if (qs.some((q) => !Array.isArray(q.options) || q.options.length > 8)) throw refuse(MISMATCH, 409);
  const plan = checkAnswers(qs, answers);
  if (answering.has(sessionId)) throw refuse("Already answering it", 409);
  const name = s.tmux.split(":")[0], socket = socketFor(name), QUIET = { encoding: "utf8" as const, stdio: ["ignore", "pipe", "ignore"] as ("ignore" | "pipe")[] };
  const io: PickerIO = {
    screen: () => { try { return execFileSync("tmux", [...socket, "capture-pane", "-p", "-t", `=${name}:`], QUIET); } catch { return ""; } },
    press: (args) => { execFileSync("tmux", [...socket, "send-keys", "-t", `=${name}:`, ...args], QUIET); },
  };
  answering.add(sessionId);
  try { return { ok: true, answers: await drivePicker(io, qs, plan, opts) }; }
  finally { answering.delete(sessionId); }
}
