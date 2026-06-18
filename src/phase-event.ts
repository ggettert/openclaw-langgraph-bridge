/**
 * Phase event contract — canonical TypeScript types for the custom-stream
 * payload that LangGraph workflow nodes emit via `get_stream_writer()` to
 * signal phase transitions.
 *
 * The plugin's `translateFleetVocabulary` function in event-subscriber.ts
 * consumes this shape and maps it to Mode B `{kind, title, summary, ...}`
 * events that wake the agent.
 *
 * Contract version: schema_version=1 (see docs/phase-event-contract.md)
 *
 * Backward compatibility: schema_version is optional. Payloads conforming to
 * the v1 contract require `summary`; legacy payloads without `summary` fall
 * through to translateFleetVocabulary's summarizeFleetData heuristics.
 */

/** Valid values for the `event` field in a PhaseEventPayload. */
export type PhaseEventName = "started" | "finished" | "failed";

/**
 * Reviewer verdict values. Surfaced in the `verdict` field of a
 * `reviewer:finished` event (and optionally other phase events).
 */
export type PhaseVerdict = "approve" | "must_fix" | "should_fix" | "abort";

/**
 * Canonical shape of a custom-stream event emitted by a workflow node that
 * uses the fleet phase-event vocabulary.
 *
 * Required fields: `phase`, `event`, `ticket_id`, `summary`
 * Optional fields: `schema_version`, `pr_url`, `branch`, `verdict`, `error`, `details`
 *
 * See docs/phase-event-contract.md for full documentation, worked examples,
 * and evolution notes.
 */
export type PhaseEventPayload = {
  /**
   * Schema version. Currently always 1.
   * The plugin ignores this field for now but records it so future versions
   * can apply version-specific parsing rules without breaking old consumers.
   */
  schema_version?: number;

  /**
   * Name of the workflow phase (e.g. "coder", "reviewer", "merge_gate", "merge").
   * Workflow authors may define their own phase names — the plugin handles any string.
   */
  phase: string;

  /**
   * Lifecycle event within the phase.
   * - "started"  → phase just began (post ack to thread)
   * - "finished" → phase completed successfully (post outcome)
   * - "failed"   → phase failed (post short error summary)
   */
  event: PhaseEventName;

  /**
   * Linear / Jira ticket ID. Used in summaries and log correlation.
   * Example: "BINGO-42"
   */
  ticket_id: string;

  /**
   * Human-readable one-liner describing what happened.
   * When present (non-empty), the plugin uses this directly instead of
   * generating a summary from the other fields via heuristics.
   * Truncated by the plugin via `summaryMaxChars` (configurable, default 4000)
   * in processEvent before delivery.
   *
   * Examples:
   *   started:  "analyzing spec"
   *   finished: "opened PR #42"
   *   failed:   "RuntimeError: git push rejected: non-fast-forward"
   */
  summary: string;

  /**
   * URL of the pull request opened or reviewed during this phase.
   * Present on coder:finished, reviewer:finished, merge:finished, etc.
   */
  pr_url?: string | null;

  /**
   * Git branch name. Useful context for started/finished events.
   */
  branch?: string | null;

  /**
   * Reviewer verdict. Typically set on reviewer:finished events.
   * One of: "approve", "must_fix", "should_fix", "abort"
   */
  verdict?: PhaseVerdict | null;

  /**
   * Short error description for failed events.
   * Should be ErrorType + first line of the message — enough to start
   * diagnosis without a full stack trace.
   * Example: "RuntimeError: git push rejected: non-fast-forward"
   */
  error?: string | null;

  /**
   * Arbitrary extra fields for workflow-specific context.
   * The plugin passes these through to body.data but does not format them
   * in the wake summary.
   */
  details?: Record<string, unknown> | null;
};

/**
 * Type guard: returns true when `data` is a valid PhaseEventPayload.
 *
 * Required: phase (string), event (started|finished|failed),
 *           ticket_id (string), summary (string).
 * All other fields are optional and are not validated beyond type.
 *
 * This guard is intentionally lenient on optional fields — presence/absence
 * of pr_url/branch/verdict/error does not affect validity.
 */
export function isPhaseEventPayload(data: unknown): data is PhaseEventPayload {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.phase === "string" &&
    typeof d.event === "string" &&
    ["started", "finished", "failed"].includes(d.event) &&
    typeof d.ticket_id === "string" &&
    typeof d.summary === "string" &&
    d.summary.length > 0
  );
}
