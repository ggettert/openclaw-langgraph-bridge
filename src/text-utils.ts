/**
 * Shared text utilities for summary truncation in wake messages.
 *
 * Used by both the SSE-frame path (event-subscriber.ts) and the webhook
 * path (webhook-handler.ts) to keep truncation behaviour consistent.
 * Future event-shape work (#42 phase events, etc.) should import these
 * rather than reinvent.
 */

/**
 * Default cap for summary strings extracted from SSE frames. 280 was an
 * arbitrary early-Phase-2 sketch value; node-state deltas + reviewer
 * findings routinely exceed that. 4000 chars is generous without being
 * abusive to agent CLI invocations.
 *
 * Configurable via plugin config (`summaryMaxChars`); the default is used
 * by call sites that have no access to runtime config.
 */
export const DEFAULT_SUMMARY_MAX_CHARS = 4000;

/**
 * Truncate a plain string to at most `maxChars` characters. When
 * truncation is needed the cut is made at the last ASCII whitespace
 * within the window so we never split mid-word. A ` …[truncated]` suffix
 * is appended.
 */
export function truncateSummary(
  text: string,
  maxChars = DEFAULT_SUMMARY_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  const lastSpace = window.lastIndexOf(" ");
  const cut = lastSpace > 0 ? window.slice(0, lastSpace) : window;
  return cut + " \u2026[truncated]";
}

/**
 * Serialize `data` to a summary string with JSON-aware truncation.
 *
 * If the compact serialisation fits within `maxChars`, it is returned
 * verbatim. When it exceeds the cap we use pretty-printed JSON
 * (`JSON.stringify(data, null, 2)`) before truncating so the cut always
 * lands between tokens (keys and values are on separate indented lines).
 * This guarantees we never emit broken-quote output like
 *   `"feature/BINGO-darkmode-build-41830   ← no closing quote`.
 */
export function truncateJsonSummary(
  data: unknown,
  maxChars = DEFAULT_SUMMARY_MAX_CHARS,
): string {
  try {
    const compact = JSON.stringify(data);
    if (compact.length <= maxChars) return compact;
    // Pretty-print so whitespace separates tokens; then cut at whitespace.
    const pretty = JSON.stringify(data, null, 2);
    return truncateSummary(pretty, maxChars);
  } catch {
    return "(unsummarizable)";
  }
}
