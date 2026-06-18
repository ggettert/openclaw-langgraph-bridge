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
 * truncation is needed the cut is made at the last ASCII space (0x20)
 * within the window so we never split mid-word. A ` …[truncated]` suffix
 * is appended. Other whitespace characters (newlines, tabs) are not
 * treated as cut points — if a value contains no space within the window
 * the cut falls at `maxChars` exactly.
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
 * (`JSON.stringify(data, null, 2)`) before truncating so the cut is
 * much more likely to land between tokens (keys and values are on
 * separate indented lines).
 *
 * Caveat: the cut is at the last space within the window. If a string
 * value contains spaces the cut can still land inside the value, which
 * leaves an unclosed quote in the literal output. Acceptable for our
 * use case because the result is rendered as text in a wake message,
 * not parsed as JSON downstream. If we ever need parseable output we'd
 * need a real JSON-aware truncator (e.g. walk the AST).
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
