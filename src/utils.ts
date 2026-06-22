/**
 * Pure utility helpers shared across the plugin.
 */

/**
 * Coerce a value that may already be a plain object, a JSON string, or
 * null/undefined into a plain object (or null when it cannot be coerced).
 */
export function parseMaybeJson(
  raw: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return raw;
}
