import { execFileSync } from "node:child_process";
import { socketFor } from "./tmux.ts";

/**
 * "Is this session waiting on Vedran, and what are the likely answers?" for the popup's quick replies.
 *  - permission: Claude Code's own dialog on screen ("Do you want to…? 1. Yes 2. … 3. No"): answered by
 *    pressing the option's number key.
 *  - question: its last message asks something ("Reply \"2\" to file it", numbered choices, "…?"):
 *    answered by typing the text, exactly like a typed reply.
 * Nothing here sends anything; the map only shows buttons, and sending happens on Vedran's click.
 */

export interface AskOption { label: string; send?: string; key?: string }
/** `note`: shown instead of buttons when the options can't be guessed (several open questions). */
/** `picker`: Claude Code's AskUserQuestion picker (from the transcript, or seen on its screen). */
export interface Ask { kind: "permission" | "question"; options: AskOption[]; note?: string; question?: string; picker?: boolean }

const clean = (s: string) => s.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
/** Button text: at most `n` characters, cut at a word. */
const short = (s: string, n = 48) => s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "") + "…";
const NUMBERED = /^(?:[-*•]\s*)?(\d{1,2})[.)]\s+(.{2,200})$/;
const CHOICE_CUE = /\?|\b(which|choose|pick|option|options|select|prefer|want me to)\b/i;
/** Words "reply X" may name without quotes; anything else needs quotes ("Here's a reply you could post" isn't an answer). */
const BARE_ANSWER = /^(\d{1,2}|[a-d]|yes|no|y|n|go|ok|okay|continue|proceed|skip|stop|cancel|both|all|none|done)$/i;
/** Lead-ins dropped from the two sides of "A, or B?" so the button reads as the answer. */
const LEAD_IN = /^(?:so\s+|and\s+|or\s+)?(?:do you want(?: me)?(?: to)?|would you (?:like|rather|prefer)(?: me)?(?: to)?|want(?: me to)?|should (?:I|we)|shall (?:I|we)|can I|ok to|okay to|is it|you want(?: me)?(?: to)?)\s+/i;

/** "Want it committed, or left as a working note?" → the two answers. Undefined when it isn't an either/or. */
function eitherOr(question: string): AskOption[] | undefined {
  const q = clean(question).replace(/\?+\s*$/, "");
  const sentence = q.split(/(?<=[.!:])\s+/).at(-1) ?? q;
  const m = sentence.match(/^(.*\S),?\s+or\s+(.+)$/i);
  if (!m) return;
  const side = (s: string) => s.replace(LEAD_IN, "").replace(/^(?:it|them|this|that)\s+(?=\S)(?!one\b)/i, "").replace(/[,.;]+$/, "").trim();
  let a = side(m[1]); const b = side(m[2]);
  if (/^(not|no|so|more|less|anything else|something else|what|later)$/i.test(b) || b.length < 3 || /\bor\b/i.test(b)) return;
  const options: AskOption[] = [];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (/^(that|this|it|them|those|these)$/i.test(a)) options.push({ label: `Yes, do ${a.toLowerCase()}`, send: `Yes, do ${a.toLowerCase()}.` });
  else if (a.length >= 2) options.push({ label: short(cap(a)), send: cap(a) });
  else return;
  options.push({ label: short(cap(b)), send: cap(b) });
  return options;
}

/** Options from a message's text. Undefined when it doesn't look like a question. */
export function askFromText(text: string | undefined): Ask | undefined {
  if (!text) return;
  const tail = text.trim().slice(-1500);
  const lastLines = tail.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith(">")).slice(-12);
  const options: AskOption[] = [];
  const seen = new Set<string>();
  const add = (o: AskOption) => { const k = (o.send ?? o.key ?? "").toLowerCase(); if (k && !seen.has(k)) { seen.add(k); options.push(o); } };

  // Numbered choices: the last numbered block, with a choice cue right before it ("Which one?") or after it.
  // Items that are questions themselves ("2. Will X allow Y?") are things to answer, not answers to pick.
  let end = -1;
  for (let i = lastLines.length - 1; i >= 0 && end < 0; i--) if (NUMBERED.test(lastLines[i])) end = i;
  let numberedQuestions = 0;
  if (end >= 0) {
    let start = end;
    while (start > 0 && NUMBERED.test(lastLines[start - 1])) start--;
    const items = lastLines.slice(start, end + 1).map((l) => l.match(NUMBERED)!);
    numberedQuestions = items.filter((m) => /\?\s*$/.test(clean(m[2]))).length;
    // The cue is the line right before ("Which one?", "Options:") or right after naming the numbers ("Which one?",
    // "Pick a number"). A question further down doesn't make a list of findings into a menu.
    const cue = CHOICE_CUE.test(lastLines[start - 1] ?? "") || /^options?\s*:/i.test(lastLines[start - 1] ?? "") ||
      /\b(which|pick|choose|option|number)\b/i.test(lastLines[end + 1] ?? "");
    if (cue && numberedQuestions === 0) for (const m of items) add({ label: short(`${m[1]}. ${clean(m[2])}`), send: m[1] });
  }
  // Explicit instructions: Reply "2" / reply yes / say "go", plus other quoted choices in that sentence
  // ('Reply "2" to file it, or "1" to just fix it'). Bold/italic markers don't count ("Reply **2** here").
  const plain = tail.replace(/\*\*|__/g, "");
  for (const sentence of plain.split(/(?<=[.!?])\s+|\n/)) {
    if (!/\b(reply|answer|say|type)\b/i.test(sentence)) continue;
    const bare = sentence.match(/\b(?:reply|answer|say|type)\s+(?:with\s+)?([\w-]{1,20})\b/i)?.[1];
    if (bare && BARE_ANSWER.test(bare)) add({ label: bare, send: bare });
    for (const m of sentence.matchAll(/["“`]([\w-]{1,20})["”`]/g)) add({ label: m[1], send: m[1] });
  }
  // The question it ends on: the last line, or a question just before a closing line or two ("Here's a reply you could post:").
  const isQ = (l: string) => /\?\s*[)\]"”'*]*\s*$/.test(l);
  const last = lastLines.slice(-3).reverse().find(isQ) ?? "";
  const endsWithQuestion = !!last;
  const waiting = waitingOnYou(tail);
  if (!options.length && endsWithQuestion) for (const o of eitherOr(last.split(/(?<=[.!])\s+/).filter(isQ).at(-1) ?? last) ?? []) add(o);
  if (/\b(yes\s*\/\s*no|y\s*\/\s*n)\b/i.test(tail) || ((endsWithQuestion || waiting) && !options.length && numberedQuestions < 2)) {
    add({ label: "Yes", send: "yes" }); add({ label: "No", send: "no" });
  }
  if (!options.length && numberedQuestions >= 2)
    return { kind: "question", options: [], note: `It asked ${numberedQuestions} questions: answer them in the reply box.` };
  if (!options.length && !endsWithQuestion && !waiting) return;
  return { kind: "question", options: options.slice(0, 8) };
}

/**
 * "It's waiting for your go" without ending on a question: a bold question or a "Decision for you:" line
 * mid-reply, "I need your yes before I touch…", "I haven't moved them yet" + "Proposed:", "Permission to …".
 * Kept narrow on purpose: a report that merely mentions approvals shouldn't light up the "?".
 */
export function waitingOnYou(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim());
  // A question set in bold on its own ("**Move A and B to Done?**"), or a decision/OK/question heading.
  if (lines.some((l) => /^\*\*[^*]{4,200}\?\*\*/.test(l))) return true;
  if (lines.some((l) => /^(?:[-*]\s*)?\**\s*(?:decision for you|needs your (?:ok|okay|yes|go|approval)|question for you|permission to\b)/i.test(l))) return true;
  const flat = text.replace(/\*\*|__|`/g, "");
  if (/(?<!n't |not |no )\b(?:need|needs|still need|waiting (?:for|on)|wait for)\s+(?:your|vedran's|his)\s+(?:own\s+)?(?:yes|ok|okay|go|go-ahead|approval|permission|sign-off|confirmation|decision)\b/i.test(flat)) return true;
  if (/\bI've asked (?:you|him)\b/i.test(flat)) return true;
  // "I haven't moved them yet" only counts together with a proposal or a direct question to you.
  const notYet = /\bhaven't\s+(?:\w+\s+){0,2}?(?:moved|pushed|created|filed|merged|changed|deleted|deployed|sent|posted|run|touched|opened|closed|updated)\b[^.\n]{0,80}\byet\b/i.test(flat);
  const proposal = /^(?:[-*]\s*)?(?:proposed|proposal|suggested)\s*:/im.test(flat) || /\b(?:should|shall|can|may) I\b[^.?\n]*\?|\b(?:do you want|want me to|ok to|okay to)\b[^.?\n]*\?/i.test(flat);
  return notYet && proposal;
}

/**
 * AskUserQuestion still waiting: Claude Code shows its own picker, where the number keys choose. One question with
 * one answer → a button per option (presses its number). Several questions or multi-select → no buttons, a note.
 */
export function askFromQuestion(input: any): Ask | undefined {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  if (!qs.length) return;
  const q = qs[0];
  if (qs.length > 1 || q.multiSelect)
    return { kind: "question", options: [], picker: true, question: clean(String(q.question ?? "")), note: `It's asking ${qs.length > 1 ? `${qs.length} questions` : "a pick-several question"} in its picker: answer in the form above, or in the Terminal tab.` };
  const options = (Array.isArray(q.options) ? q.options : []).slice(0, 9).map((o: any, i: number) => ({ label: short(`${i + 1}. ${clean(String(o.label ?? ""))}`), key: String(i + 1) }));
  return { kind: "permission", options, picker: true, question: clean(String(q.question ?? "")) };
}

/** Options from Claude Code's permission dialog as shown on the terminal screen; an open question picker is a note. */
export function askFromScreen(screen: string): Ask | undefined {
  if (parsePicker(screen)) return { kind: "question", options: [], picker: true, note: "A question picker is open in its terminal: answer it in the Terminal tab." };
  const lines = screen.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  const tail = lines.slice(-20);
  if (!tail.some((l) => /Do you want|Would you like|permission|Allow/i.test(l))) return;
  const options: AskOption[] = [];
  for (const line of tail) {
    const m = line.match(/^\s*(?:[❯›>]\s*)?(\d)\.\s+(.+)$/);
    if (m) options.push({ label: `${m[1]}. ${clean(m[2]).slice(0, 60)}`, key: m[1] });
  }
  return options.length ? { kind: "permission", options } : undefined;
}

export function captureScreen(tmux: string): string {
  const name = tmux.split(":")[0];
  try {
    return execFileSync("tmux", [...socketFor(name), "capture-pane", "-p", "-t", `=${name}:`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/**
 * Claude Code's AskUserQuestion picker as `capture-pane -p` shows it (2.1.300): a tab bar ("←  ☐ Color  ☒ Size  ✔ Submit  →";
 * just " ☐ Plan" for one single-select question; the current tab differs only by colour), the question, then "❯ 1. Red" /
 * "  2. Green" rows (descriptions indented under them), "N. Type something." (the free-text row), and for multiSelect
 * "[ ]"/"[✔]" boxes plus a "Next" (or, on the last question, "Submit") row. The last step is "Review your answers" with
 * "→ answer" lines and "❯ 1. Submit answers". Undefined when no picker is on screen.
 */
export interface PickerRow { n?: number; label: string; checked?: boolean; cursor: boolean }
export interface PickerScreen { tabs: { label: string; done: boolean }[]; title: string; review: boolean; rows: PickerRow[]; answers: string[]; incomplete: boolean }
const TAB_BAR = /^\s*(?:←\s+)?[☐☒]\s\S/;
export function parsePicker(screen: string): PickerScreen | undefined {
  const lines = screen.split("\n").map((l) => l.replace(/\s+$/, ""));
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (TAB_BAR.test(lines[i])) at = i;
  if (at < 0) return;
  const rest = lines.slice(at + 1);
  if (!rest.some((l) => /Enter to select|Submit answers/.test(l))) return;
  const tabs = [...lines[at].matchAll(/([☐☒✔])\s(.+?)(?=\s{2,}|\s*→|$)/g)].filter((m) => m[1] !== "✔").map((m) => ({ label: m[2].trim(), done: m[1] === "☒" }));
  const title = rest.find((l) => l.trim())?.trim() ?? "";
  const rows: PickerRow[] = [], answers: string[] = [];
  for (const l of rest) {
    // Rows start at column 0 ("❯ " or two spaces); descriptions and wrapped lines are indented further.
    const m = l.match(/^(❯ | {2})(\d+)\.\s(?:\[([ ✔])\]\s)?(.*)$/);
    if (m) { rows.push({ n: Number(m[2]), label: m[4].trim(), checked: m[3] === undefined ? undefined : m[3] === "✔", cursor: m[1] === "❯ " }); continue; }
    const next = l.match(/^(❯ | {2})\s+(Next|Submit)$/);
    if (next) { rows.push({ label: next[2], cursor: next[1] === "❯ " }); continue; }
    const a = l.match(/^\s*→\s+(.*)$/);
    if (a) answers.push(a[1].trim());
  }
  return { tabs, title, review: title === "Review your answers", rows, answers, incomplete: rest.some((l) => /not answered all questions/.test(l)) };
}
