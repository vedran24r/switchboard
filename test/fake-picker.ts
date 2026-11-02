import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * A stand-in for Claude Code's AskUserQuestion picker (2.1.300), for tests: it takes the same keys and draws the same
 * screen as `capture-pane -p` showed for the real one on 2026-10-30 (layout, rows, boxes, the review step), with
 * placeholder questions. It never runs anything. Run as a script it is a fake `tmux`: `capture-pane` prints the screen,
 * `send-keys` presses keys, state lives in $FAKE_PICKER_STATE, and every call is logged there.
 */

export interface FakeQuestion { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }
interface Answer { picks: number[]; other: string }
export interface FakeState {
  questions: FakeQuestion[]; tab: number; cursor: number; review: boolean; closed: "" | "submitted" | "cancelled";
  answers: Answer[]; keys: string[]; calls: string[];
  /** Ignore this key (0-based count of key presses), as if the picker missed it. */
  drop?: number;
  /** Start somewhere else (a different question showing), as if someone already moved in the terminal. */
  startTab?: number;
}

export function newPicker(questions: FakeQuestion[], extra: Partial<FakeState> = {}): FakeState {
  const st: FakeState = { questions, tab: 0, cursor: 1, review: false, closed: "", answers: questions.map(() => ({ picks: [], other: "" })), keys: [], calls: [], ...extra };
  if (extra.startTab) st.tab = extra.startTab;
  return st;
}

const W = 100, RULE = "─".repeat(W);
const answered = (q: FakeQuestion, a: Answer) => a.picks.length > 0 || !!a.other;
const answerText = (q: FakeQuestion, a: Answer) => [...[...a.picks].sort((x, y) => x - y).map((p) => q.options[p].label), ...(a.other ? [a.other] : [])].join(", ");

function advance(st: FakeState) {
  st.cursor = 1;
  if (st.questions.length === 1 && !st.questions[0].multiSelect) { st.closed = "submitted"; return; }
  if (st.tab + 1 >= st.questions.length) st.review = true; else st.tab++;
}

export function press(st: FakeState, args: string[]) {
  const n = st.keys.length;
  st.keys.push(args.join(" "));
  if (st.closed || st.drop === n) return;
  const key = args[0] === "-l" ? null : args[0];
  const text = args[0] === "-l" ? args.slice(args[1] === "--" ? 2 : 1).join(" ") : "";
  if (st.review) {
    if (key === "Down") st.cursor = Math.min(2, st.cursor + 1);
    else if (key === "Up") st.cursor = Math.max(1, st.cursor - 1);
    else if (key === "Enter") st.closed = st.cursor === 1 ? "submitted" : "cancelled";
    else if (key === "Escape") st.closed = "cancelled";
    else if (key === "Left" || key === "BTab") { st.review = false; st.cursor = 1; }
    return;
  }
  const q = st.questions[st.tab], a = st.answers[st.tab], opts = q.options.length;
  const last = q.multiSelect ? opts + 2 : opts + 1;
  const toggle = (i: number) => { a.picks = a.picks.includes(i) ? a.picks.filter((x) => x !== i) : [...a.picks, i]; };
  if (key === "Down") st.cursor = Math.min(last, st.cursor + 1);
  else if (key === "Up") st.cursor = Math.max(1, st.cursor - 1);
  else if (key === "Escape") st.closed = "cancelled";
  else if (key === "Right" || key === "Tab") { st.cursor = 1; if (st.tab + 1 >= st.questions.length) st.review = true; else st.tab++; }
  else if (key === "Left" || key === "BTab") { st.cursor = 1; st.tab = Math.max(0, st.tab - 1); }
  else if (key === "Space" && q.multiSelect && st.cursor <= opts) toggle(st.cursor - 1);
  else if (key === "Enter") {
    if (q.multiSelect) { if (st.cursor <= opts) toggle(st.cursor - 1); else if (st.cursor === opts + 2) advance(st); }
    else if (st.cursor <= opts) { a.picks = [st.cursor - 1]; a.other = ""; advance(st); }
    else if (a.other) { a.picks = []; advance(st); }
  } else if (text) {
    // Typing on the free-text row writes there; elsewhere a number key picks (single) or toggles (multi) that option.
    if (st.cursor === opts + 1) a.other += text;
    else if (/^\d$/.test(text) && Number(text) <= opts) { if (q.multiSelect) toggle(Number(text) - 1); else { a.picks = [Number(text) - 1]; advance(st); } }
  }
}

export function render(st: FakeState): string {
  const out = ["⏺ Let me ask a couple of things first.", ""];
  if (st.closed === "submitted") {
    out.push("⏺ User answered Claude's questions:", ...st.questions.map((q, i) => `  ⎿  · ${q.question} → ${answerText(q, st.answers[i])}`), "", RULE, "❯ ", RULE);
    return out.join("\n") + "\n";
  }
  if (st.closed === "cancelled") return out.concat(["⏺ User declined to answer questions", "", RULE, "❯ ", RULE]).join("\n") + "\n";
  const qs = st.questions;
  const mark = (i: number) => (answered(qs[i], st.answers[i]) ? "☒" : "☐");
  const one = qs.length === 1 && !qs[0].multiSelect;
  out.push(RULE, one ? ` ${mark(0)} ${qs[0].header}` : `←  ${qs.map((q, i) => `${mark(i)} ${q.header}`).join("  ")}  ✔ Submit  →`, "");
  const cur = (row: number) => (st.cursor === row ? "❯ " : "  ");
  if (st.review) {
    out.push("Review your answers", "");
    if (qs.some((q, i) => !answered(q, st.answers[i]))) out.push("⚠ You have not answered all questions");
    for (const [i, q] of qs.entries()) if (answered(q, st.answers[i])) out.push(` ● ${q.question}`, `   → ${answerText(q, st.answers[i])}`);
    out.push("", "Ready to submit your answers?", "", `${cur(1)}1. Submit answers`, `${cur(2)}2. Cancel`);
    return out.join("\n") + "\n";
  }
  const q = qs[st.tab], a = st.answers[st.tab], n = q.options.length;
  out.push(q.question, "");
  for (const [j, o] of q.options.entries()) {
    if (q.multiSelect) out.push(`${cur(j + 1)}${j + 1}. [${a.picks.includes(j) ? "✔" : " "}] ${o.label}`, ...(o.description ? [`         ${o.description}`] : []));
    else out.push(`${cur(j + 1)}${j + 1}. ${o.label}${a.picks[0] === j ? " ✔" : ""}`, ...(o.description ? [`     ${o.description}`] : []));
  }
  if (q.multiSelect) out.push(`${cur(n + 1)}${n + 1}. [${a.other ? "✔" : " "}] ${a.other || "Type something"}`, `${cur(n + 2)}   ${st.tab === qs.length - 1 ? "Submit" : "Next"}`);
  else out.push(`${cur(n + 1)}${n + 1}. ${a.other || "Type something."}`);
  out.push(RULE, `  ${n + 2}. Chat about this`, "", `Enter to select · ${one ? "↑/↓ to navigate" : "Tab/Arrow keys to navigate"} · Esc to cancel`);
  return out.join("\n") + "\n";
}

/** As a fake `tmux`: `[-L sock] capture-pane … | send-keys -t T keys…`. Anything else fails, like a missing session. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.env.FAKE_PICKER_STATE!;
  const st: FakeState = JSON.parse(readFileSync(file, "utf8"));
  const args = process.argv.slice(2);
  st.calls.push(args.join(" "));
  const sk = args.indexOf("send-keys");
  if (sk >= 0) press(st, args.slice(args.indexOf("-t", sk) + 2));
  writeFileSync(file, JSON.stringify(st));
  if (args.includes("capture-pane")) process.stdout.write(render(st));
  else if (sk < 0) process.exit(1);
}
