import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/**
 * Agents a session has running right now (Agent/Task tool), for the "🤖 2 agents running" marker.
 * - A foreground agent: its tool_use has no tool_result yet.
 * - A background one: its tool_result says `isAsync` with an agentId, until a `<task-notification>` with that
 *   task-id arrives (a queued_command attachment, or a user line) with a final status.
 * Transcripts get big (tens of MB), so each file is read once and then only the bytes added since.
 */
export interface RunningAgent { id: string; description: string; since: number; background: boolean }

interface Scan { offset: number; rest: string; pending: Map<string, RunningAgent>; running: Map<string, RunningAgent> }
const scans = new Map<string, Scan>();
const AGENT_TOOLS = new Set(["Agent", "Task"]);

function apply(scan: Scan, line: string) {
  // Cheap filter first: almost every line is about something else.
  if (!line.includes('"Agent"') && !line.includes('"Task"') && !line.includes("isAsync") && !line.includes("task-notification") && !line.includes("tool_result")) return;
  let e: any;
  try { e = JSON.parse(line); } catch { return; }
  if (e.isSidechain) return;
  const at = Date.parse(e.timestamp) || Date.now();
  const content = e.message?.content;
  if (e.type === "assistant" && Array.isArray(content)) {
    for (const b of content) if (b?.type === "tool_use" && AGENT_TOOLS.has(b.name))
      scan.pending.set(b.id, { id: b.id, description: String(b.input?.description ?? b.input?.subagent_type ?? "agent"), since: at, background: false });
  }
  if (e.type === "user" && Array.isArray(content)) {
    for (const b of content) {
      if (b?.type !== "tool_result" || !scan.pending.has(b.tool_use_id)) continue;
      const agent = scan.pending.get(b.tool_use_id)!;
      scan.pending.delete(b.tool_use_id);
      const r = e.toolUseResult;
      if (r?.isAsync && r.agentId) scan.running.set(String(r.agentId), { ...agent, id: String(r.agentId), description: String(r.description ?? agent.description), background: true });
    }
  }
  // Finished background agents: the notification text, wherever it was delivered.
  const text = e.type === "attachment" && e.attachment?.type === "queued_command" ? String(e.attachment.prompt ?? "")
    : e.type === "user" && typeof content === "string" ? content
    : e.type === "user" && Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
  if (text.startsWith("<task-notification>")) {
    const id = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
    const status = text.match(/<status>([^<]+)<\/status>/)?.[1] ?? "";
    if (id && /completed|failed|killed|cancel|stopped|error/i.test(status)) scan.running.delete(id);
  }
}

export function runningAgents(file: string | undefined): RunningAgent[] {
  if (!file || !existsSync(file)) return [];
  const size = statSync(file).size;
  let scan = scans.get(file);
  if (!scan || size < scan.offset) scans.set(file, (scan = { offset: 0, rest: "", pending: new Map(), running: new Map() }));
  if (size > scan.offset) {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - scan.offset);
      readSync(fd, buffer, 0, buffer.length, scan.offset);
      const lines = (scan.rest + buffer.toString("utf8")).split("\n");
      scan.rest = lines.pop() ?? ""; // a line still being written
      for (const line of lines) apply(scan, line);
      scan.offset = size;
    } finally { closeSync(fd); }
  }
  // A foreground agent whose session ended mid-call would stay "pending" forever: only count recent ones.
  const fresh = [...scan.pending.values()].filter((a) => Date.now() - a.since < 6 * 3_600_000);
  // A background one whose finish notice never came (session restarted) fades out after a day.
  const live = [...scan.running.values()].filter((a) => Date.now() - a.since < 24 * 3_600_000);
  return [...fresh, ...live].sort((a, b) => a.since - b.since);
}
