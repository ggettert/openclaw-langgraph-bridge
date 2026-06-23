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
      // Guard against arrays (typeof [] === "object") and other non-plain-object
      // values; the return-type contract is Record<string, unknown> | null and
      // arrays do not satisfy that shape.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return raw;
}
