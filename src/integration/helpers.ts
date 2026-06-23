/**
 * Shared helpers for integration tests.
 *
 * These tests require a running LangGraph server. By default they target
 * `http://localhost:2024`; override with `LANGGRAPH_BASE_URL`.
 *
 * ## Enabling integration tests
 *
 * Integration tests run when at least one of the following env vars is set:
 *   - `LANGGRAPH_BASE_URL`  – points at a non-default server (natural choice
 *                             when running against a LangSmith Deployment or
 *                             a custom host).
 *   - `RUN_INTEGRATION=1`   – explicit opt-in when using the default
 *                             localhost:2024 address.
 *
 * Without either env var, `isLangGraphReachable()` short-circuits without
 * making any network call, so `npm test` (unit-only) is always fast and
 * clean even if the vitest exclude glob ever drifts.
 *
 * ## Assistant requirement
 *
 * The default workflow is `integration-stub`, which matches the minimal
 * example graph in `examples/integration-test-graph/`.  Override with
 * `LANGGRAPH_WORKFLOW=<id>` to target a different assistant.
 *
 * Use `isLangGraphReachable()` at the top of each integration describe block:
 *
 *   const reachable = await isLangGraphReachable();
 *   describe.skipIf(!reachable)("My integration suite", () => { ... });
 *
 * Since vitest evaluates `describe.skipIf` synchronously, call
 * `isLangGraphReachable()` in a top-level `await` (ESM top-level await,
 * supported in vitest's ESM test runner).
 */

export const LANGGRAPH_BASE_URL = process.env.LANGGRAPH_BASE_URL ?? "http://localhost:2024";

export const LANGGRAPH_WORKFLOW = process.env.LANGGRAPH_WORKFLOW ?? "integration-stub";

export const LANGGRAPH_API_KEY = process.env.LANGGRAPH_API_KEY;
export const LANGGRAPH_AUTH_SCHEME = process.env.LANGGRAPH_AUTH_SCHEME;

/**
 * Probe the LangGraph `/info` endpoint, then confirm the configured
 * assistant (`LANGGRAPH_WORKFLOW`) is registered.
 *
 * Returns `true` only when BOTH the server is up AND the assistant exists.
 * Returns `false` (with a clear console.warn) when the server is up but
 * the assistant is missing.
 * Returns `false` silently when the server is not reachable.
 *
 * Short-circuits without any network call when neither `LANGGRAPH_BASE_URL`
 * nor `RUN_INTEGRATION` is set — safe to call from `npm test`.
 */
export async function isLangGraphReachable(timeoutMs = 1000): Promise<boolean> {
  // Belt-and-braces guard: never make a network call from `npm test`.
  // CI sets LANGGRAPH_BASE_URL so this short-circuit is not reached there.
  if (!process.env.LANGGRAPH_BASE_URL && !process.env.RUN_INTEGRATION) {
    return false;
  }

  // --- 1. Probe /info -------------------------------------------------
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${LANGGRAPH_BASE_URL}/info`, {
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return false;
  } catch {
    return false;
  }

  // --- 2. Confirm the assistant is registered --------------------------
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${LANGGRAPH_BASE_URL}/assistants/${LANGGRAPH_WORKFLOW}`, {
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn(
        `[integration] LangGraph reachable but assistant '${LANGGRAPH_WORKFLOW}' not found — ` +
          `skipping integration tests. ` +
          `To register: cd examples/integration-test-graph && langgraph dev --no-browser. ` +
          `Or override: LANGGRAPH_WORKFLOW=<id>.`,
      );
      return false;
    }
  } catch {
    return false;
  }

  return true;
}
