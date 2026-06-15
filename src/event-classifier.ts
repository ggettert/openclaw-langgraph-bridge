/**
 * Phase 2 — Event classifier.
 *
 * Pure function: maps an inbound LangGraph webhook event payload to the
 * routing decision the webhook handler should take. No I/O, no SDK calls,
 * no side effects — this is the thing that's the easiest to unit-test and
 * the easiest to be wrong about.
 *
 * Mode B contract:
 *
 *   kind="status"     → update flow state only. Do not wake the agent.
 *   kind="milestone"  → update flow state + light wake (post a brief note).
 *   kind="decision"   → wake the agent so it can decide what to say/do.
 *   kind="terminal"   → finish the flow + wake the agent for final summary.
 *   kind="hitl"       → set the flow to waiting + wake the agent to ask.
 *
 * The workflow author labels events at emit time. The plugin enforces what
 * the labels mean.
 */

export type LanggraphEventKind =
  | "status"
  | "milestone"
  | "decision"
  | "terminal"
  | "hitl";

export type ClassifierAction =
  | "flow-update-only"
  | "wake-light"
  | "wake-decision"
  | "wake-terminal"
  | "wake-hitl";

export type ClassifierInput = {
  kind: LanggraphEventKind;
};

export type ClassifierResult = {
  action: ClassifierAction;
  /**
   * Should the system-event injection use a contextKey for dedup?
   * Status events that share a contextKey will collapse in the queue,
   * which is what we want for high-rate noise. Decisions/terminals
   * should not share a key.
   */
  contextKeyHint: "noise" | "wake" | "none";
};

export function classifyEvent(input: ClassifierInput): ClassifierResult {
  switch (input.kind) {
    case "status":
      return { action: "flow-update-only", contextKeyHint: "noise" };
    case "milestone":
      return { action: "wake-light", contextKeyHint: "wake" };
    case "decision":
      return { action: "wake-decision", contextKeyHint: "wake" };
    case "terminal":
      return { action: "wake-terminal", contextKeyHint: "wake" };
    case "hitl":
      return { action: "wake-hitl", contextKeyHint: "wake" };
  }
}

/**
 * Should this action ultimately call `requestHeartbeat` to wake the
 * session-bound agent? Mirrors the action enum 1:1 for now but kept as
 * its own predicate so we can change the policy in one place later.
 */
export function actionRequiresWake(action: ClassifierAction): boolean {
  return action !== "flow-update-only";
}

/**
 * Reason string passed to `requestHeartbeat({reason})`. Distinct per
 * action so we get useful logs/diagnostics.
 */
export function actionHeartbeatReason(action: ClassifierAction): string {
  return `langgraph-${action}`;
}
