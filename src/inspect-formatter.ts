/**
 * Phase 3 — langgraph_inspect formatter.
 *
 * Pure formatting: takes a managed flow record (from `flows.get`) and a
 * task summary, returns a compact human-readable string the agent can
 * read in-context. No I/O, no SDK calls.
 */

export type InspectFlowRecord = {
  flowId: string;
  status: string;
  controllerId?: string;
  goal?: string;
  currentStep?: string | null;
  stateJson?: Record<string, unknown> | string | null;
  waitJson?: Record<string, unknown> | string | null;
  endedAt?: number | null;
  revision?: number;
};

export type InspectInput = {
  flow: InspectFlowRecord | null;
  /** Optional human task summary string from getTaskSummary, if available. */
  taskSummary?: string | null;
};

export function formatInspect(input: InspectInput): string {
  if (!input.flow) {
    return "No matching LangGraph flow found in this session.";
  }
  const f = input.flow;
  const state = parseJson(f.stateJson);
  const wait = parseJson(f.waitJson);

  const lines: string[] = [];
  lines.push(`Flow: ${f.flowId}`);
  if (f.goal) lines.push(`  goal: ${f.goal}`);
  lines.push(`  status: ${f.status}`);
  if (f.currentStep) lines.push(`  current_step: ${f.currentStep}`);
  if (f.revision !== undefined) lines.push(`  revision: ${f.revision}`);

  if (state) {
    const wf = pickString(state, "workflow");
    if (wf) lines.push(`  workflow: ${wf}`);
    const tid = pickString(state, "langgraph_thread_id");
    if (tid) lines.push(`  thread_id: ${tid}`);
    const rid = pickString(state, "langgraph_run_id");
    if (rid) lines.push(`  run_id: ${rid}`);
    const tt = pickString(state, "terminal_title");
    if (tt) lines.push(`  terminal_title: ${tt}`);
    const ts = pickString(state, "terminal_summary");
    if (ts) lines.push(`  terminal_summary: ${ts}`);
  }

  if (wait) {
    lines.push(`  waiting:`);
    const interruptId = pickString(wait, "interrupt_id");
    if (interruptId) lines.push(`    interrupt_id: ${interruptId}`);
    const prompt = pickString(wait, "prompt");
    if (prompt) {
      const truncated = prompt.length > 500 ? prompt.slice(0, 500) + "\u2026" : prompt;
      lines.push(`    prompt: ${truncated}`);
    }
  }

  if (f.endedAt) {
    lines.push(`  ended_at: ${new Date(f.endedAt).toISOString()}`);
  }

  if (input.taskSummary) {
    lines.push("");
    lines.push("Task summary:");
    lines.push(input.taskSummary);
  }

  return lines.join("\n");
}

function parseJson(
  raw: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return raw;
}

function pickString(
  obj: Record<string, unknown>,
  key: string,
): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}
