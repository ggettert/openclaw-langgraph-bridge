/**
 * Shared helpers for integration tests.
 *
 * These tests require a running LangGraph server. By default they target
 * `http://localhost:2024`; override with `LANGGRAPH_BASE_URL`.
 *
 * Use `isLangGraphReachable()` synchronously at the top of each describe
 * block via:
 *
 *   const reachable = await isLangGraphReachable();
 *   describe.skipIf(!reachable)("My integration suite", () => { ... });
 *
 * Since vitest evaluates `describe.skipIf` synchronously, call
 * `isLangGraphReachable()` in a top-level `await` (ESM top-level await,
 * supported in vitest's ESM test runner).
 */

export const LANGGRAPH_BASE_URL = process.env.LANGGRAPH_BASE_URL ?? "http://localhost:2024";

export const LANGGRAPH_WORKFLOW = process.env.LANGGRAPH_WORKFLOW ?? "fleet";

/**
 * Probe the LangGraph `/info` endpoint. Returns `true` if the server is up
 * and responding with HTTP 2xx within `timeoutMs` (default 1 s).
 */
export async function isLangGraphReachable(timeoutMs = 1000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${LANGGRAPH_BASE_URL}/info`, {
      signal: controller.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}
