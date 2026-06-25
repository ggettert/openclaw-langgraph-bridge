/**
 * Integration test: F4 SIGTERM abort wiring.
 *
 * Exercises the _inflightControllers registry and SIGTERM handler
 * end-to-end against a live LangGraph server.
 *
 * Two core scenarios:
 *   1. Normal stream completion → `onClose` fires and the controller
 *      can be removed from `_inflightControllers` cleanly.
 *   2. Synthetic SIGTERM mid-stream → the registered handler aborts
 *      all in-flight controllers and clears the registry.
 *
 * These tests do NOT go through the plugin tool dispatch path
 * (langgraph_dispatch) — they use dispatchAndStream directly and
 * manually mirror the registry add/remove that index.ts does, making
 * the behaviour of the F4 fix observable without the full OpenClaw
 * SDK infrastructure.
 *
 * Skipped when LangGraph isn't reachable.
 * Run: RUN_INTEGRATION=1 npm run test:integration
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dispatchAndStream } from "../event-subscriber.js";
import { LanggraphClient } from "../langgraph-client.js";
import { _inflightControllers, _ensureSigtermHandler } from "../index.js";
import {
  isLangGraphReachable,
  LANGGRAPH_BASE_URL,
  LANGGRAPH_WORKFLOW,
  LANGGRAPH_API_KEY,
  LANGGRAPH_AUTH_SCHEME,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Availability check
// ---------------------------------------------------------------------------

const reachable = await isLangGraphReachable();

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!reachable)("F4 SIGTERM abort wiring (integration)", () => {
  const client = new LanggraphClient({
    baseUrl: LANGGRAPH_BASE_URL,
    timeoutMs: 10_000,
    apiKey: LANGGRAPH_API_KEY,
    authScheme: LANGGRAPH_AUTH_SCHEME,
  });

  // Isolate registry state between tests. The module-level _inflightControllers
  // is a singleton; clear any leftovers from previous tests or other suites.
  beforeEach(() => {
    _inflightControllers.clear();
  });

  // Belt-and-braces post-test cleanup — handles the rare case where a test
  // fails before its own cleanup path.
  afterEach(() => {
    _inflightControllers.clear();
  });

  // -------------------------------------------------------------------------
  // Test 1: normal stream completion removes controller from registry
  // -------------------------------------------------------------------------

  it("normal completion removes controller from _inflightControllers (onClose cleanup path)", async () => {
    const threadId = await client.createThread({
      openclaw_integration_test: true,
      test: "abort-wiring-normal",
      when: new Date().toISOString(),
    });

    let didClose = false;
    let ctrlInSetDuringRun = false;
    let ctrl!: ReturnType<typeof dispatchAndStream>;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        ctrl?.abort();
        reject(new Error("abort-wiring-normal: stream timed out"));
      }, 25_000);

      const cleanup = () => {
        clearTimeout(timer);
      };

      ctrl = dispatchAndStream({
        baseUrl: LANGGRAPH_BASE_URL,
        threadId,
        flowId: "abort-wiring-normal",
        assistantId: LANGGRAPH_WORKFLOW,
        input: { integration_test: "abort-wiring-normal" },
        apiKey: LANGGRAPH_API_KEY,
        authScheme: LANGGRAPH_AUTH_SCHEME,
        metadata: {
          openclaw_integration_test: true,
          openclaw_flow_id: "abort-wiring-normal",
          openclaw_session_key: "abort-wiring-session",
        },
        handlers: {
          onRunId: (_runId) => {
            // Stream is live. ctrl must already be in the registry (we
            // added it synchronously below before any async frames fired).
            ctrlInSetDuringRun = _inflightControllers.has(ctrl);
          },
          onEvent: (_body) => {
            void _body;
          },
          onError: (err) => {
            cleanup();
            reject(new Error(`abort-wiring-normal onError: ${err.message}`));
          },
          onClose: (_sawTerminal) => {
            // Mirror the cleanup that index.ts's onClose handler does.
            _inflightControllers.delete(ctrl);
            didClose = true;
            cleanup();
            resolve();
          },
        },
      });

      // Register the controller immediately after dispatchAndStream returns
      // (before any async SSE frames can arrive). This mirrors index.ts:
      //   dispatchCtrl = dispatchAndStream({...});
      //   if (!ended && dispatchCtrl) { _inflightControllers.add(dispatchCtrl); }
      _inflightControllers.add(ctrl);
    });

    // onClose fired — the real stream closed naturally.
    expect(didClose).toBe(true);

    // Controller was in the set while the run was active.
    expect(ctrlInSetDuringRun).toBe(true);

    // onClose removed the controller — registry is clean.
    expect(_inflightControllers.has(ctrl)).toBe(false);
    expect(_inflightControllers.size).toBe(0);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 2: synthetic SIGTERM aborts in-flight controllers
  // -------------------------------------------------------------------------

  it("SIGTERM-equivalent aborts all in-flight controllers and clears registry", async () => {
    // Confirm the SIGTERM handler is registered (idempotent — safe to call again).
    _ensureSigtermHandler();
    const sigtermListenerCount = process.listenerCount("SIGTERM");
    expect(sigtermListenerCount).toBeGreaterThanOrEqual(1);

    const threadId = await client.createThread({
      openclaw_integration_test: true,
      test: "abort-wiring-sigterm",
      when: new Date().toISOString(),
    });

    let ctrlAbortedBySigterm = false;
    let registryClearedBySigterm = false;
    let closedAfterAbort = false;
    let ctrl!: ReturnType<typeof dispatchAndStream>;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        // Safety: abort and reject if something unexpected stalls.
        ctrl?.abort();
        reject(new Error("abort-wiring-sigterm: timed out waiting for onClose after SIGTERM"));
      }, 25_000);

      const cleanup = () => {
        clearTimeout(timer);
      };

      ctrl = dispatchAndStream({
        baseUrl: LANGGRAPH_BASE_URL,
        threadId,
        flowId: "abort-wiring-sigterm",
        assistantId: LANGGRAPH_WORKFLOW,
        input: { integration_test: "abort-wiring-sigterm" },
        apiKey: LANGGRAPH_API_KEY,
        authScheme: LANGGRAPH_AUTH_SCHEME,
        metadata: {
          openclaw_integration_test: true,
          openclaw_flow_id: "abort-wiring-sigterm",
          openclaw_session_key: "abort-wiring-sigterm-session",
        },
        handlers: {
          onRunId: (_runId) => {
            // The metadata frame has arrived — the SSE stream is live.
            // ctrl is already in the registry (added synchronously below).
            //
            // Fire the synthetic SIGTERM NOW, while the stream is open.
            // process.emit('SIGTERM') is synchronous: it calls all registered
            // 'SIGTERM' listeners inline before returning. The handler from
            // _ensureSigtermHandler() runs and:
            //   1. calls c.abort() on every controller in _inflightControllers
            //   2. calls _inflightControllers.clear()
            //
            // We record outcomes AFTER the emit for assertion.
            process.emit("SIGTERM");

            // Synchronous post-SIGTERM state (handler already ran).
            ctrlAbortedBySigterm = ctrl.signal.aborted;
            registryClearedBySigterm = _inflightControllers.size === 0;
          },
          onEvent: (_body) => {
            // Events arriving before or during abort are fine to ignore.
            void _body;
          },
          onError: (err) => {
            // event-subscriber.ts converts AbortError to onClose, so we
            // should not reach here for a clean abort. Fail loudly if we do.
            cleanup();
            reject(new Error(`abort-wiring-sigterm unexpected onError: ${err.message}`));
          },
          onClose: (_sawTerminal) => {
            // AbortError → onClose path in event-subscriber.ts fired.
            // (Natural close is also acceptable — the abort may race with
            // the passthrough graph finishing; what matters is that the
            // controller was aborted and the registry was cleared.)
            closedAfterAbort = true;
            cleanup();
            resolve();
          },
        },
      });

      // Register the controller synchronously — mirrors the index.ts dispatch path:
      //   dispatchCtrl = dispatchAndStream({...});
      //   if (!ended && dispatchCtrl) { _inflightControllers.add(dispatchCtrl); }
      //
      // This must happen before any async SSE frames can deliver onRunId,
      // so the set is populated when onRunId fires its SIGTERM.
      _inflightControllers.add(ctrl);
    });

    // SIGTERM was fired while the stream was in flight.
    // The handler aborted the controller synchronously.
    expect(ctrlAbortedBySigterm).toBe(true);

    // The SIGTERM handler cleared the registry.
    expect(registryClearedBySigterm).toBe(true);

    // onClose fired (either via AbortError path or natural close after abort).
    expect(closedAfterAbort).toBe(true);

    // Controller's signal is permanently aborted.
    expect(ctrl.signal.aborted).toBe(true);

    // Registry is empty after the dust settles.
    // (The SIGTERM handler cleared it; onClose's attempted delete is a no-op.)
    expect(_inflightControllers.size).toBe(0);

    // No extra SIGTERM listeners were added by this test — the handler
    // count must match what it was before we started.
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListenerCount);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Test 3: optional — abort propagation to LangGraph server
  // -------------------------------------------------------------------------
  //
  // After the client aborts its SSE stream, does the LangGraph run reflect a
  // non-running status? This is best-effort: the dev server may not surface
  // a "cancelled" status (the run may appear as "success" or "error"
  // depending on whether it completed before the abort took effect).
  // We assert only that the API responds and the thread exists — not the exact
  // run status, to avoid flakiness on fast passthrough graphs.

  it("abort: LangGraph thread is still accessible after client-side abort", async () => {
    const authHeaders: Record<string, string> = {};
    if (LANGGRAPH_API_KEY) {
      authHeaders["x-api-key"] = LANGGRAPH_API_KEY;
      if (LANGGRAPH_AUTH_SCHEME) authHeaders["x-auth-scheme"] = LANGGRAPH_AUTH_SCHEME;
    }

    const threadId = await client.createThread({
      openclaw_integration_test: true,
      test: "abort-wiring-propagation",
      when: new Date().toISOString(),
    });

    let capturedRunId: string | null = null;
    let ctrl!: ReturnType<typeof dispatchAndStream>;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        ctrl?.abort();
        reject(new Error("abort-wiring-propagation: timed out"));
      }, 25_000);

      const cleanup = () => {
        clearTimeout(timer);
      };

      ctrl = dispatchAndStream({
        baseUrl: LANGGRAPH_BASE_URL,
        threadId,
        flowId: "abort-wiring-propagation",
        assistantId: LANGGRAPH_WORKFLOW,
        input: { integration_test: "abort-wiring-propagation" },
        apiKey: LANGGRAPH_API_KEY,
        authScheme: LANGGRAPH_AUTH_SCHEME,
        metadata: {
          openclaw_integration_test: true,
          openclaw_flow_id: "abort-wiring-propagation",
          openclaw_session_key: "abort-wiring-propagation-session",
        },
        handlers: {
          onRunId: (runId) => {
            capturedRunId = runId;
            // Abort as soon as we know the run ID.
            ctrl.abort();
          },
          onEvent: (_body) => {
            void _body;
          },
          onError: (_err) => {
            // Absorb — abort may surface here before onClose on some paths.
            void _err;
          },
          onClose: () => {
            cleanup();
            resolve();
          },
        },
      });
    });

    // We got a run ID before aborting.
    expect(typeof capturedRunId).toBe("string");
    expect(capturedRunId!.length).toBeGreaterThan(0);

    // The thread must still be accessible via the LangGraph API after abort.
    const threadRes = await fetch(`${LANGGRAPH_BASE_URL}/threads/${threadId}`, {
      headers: authHeaders,
    });
    expect(threadRes.ok).toBe(true);
    const threadData = (await threadRes.json()) as { thread_id?: string; status?: string };
    expect(threadData.thread_id).toBe(threadId);

    // Run list for the thread should include our run. Status may be
    // "success", "error", or "pending" depending on race with abort.
    // We do NOT assert a specific status to avoid flakiness.
    const runsRes = await fetch(`${LANGGRAPH_BASE_URL}/threads/${threadId}/runs`, {
      headers: authHeaders,
    });
    expect(runsRes.ok).toBe(true);
    const runs = (await runsRes.json()) as Array<{ run_id?: string; status?: string }>;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeGreaterThan(0);

    const matchedRun = runs.find((r) => r.run_id === capturedRunId);
    expect(matchedRun).toBeDefined();

    console.info(
      `[abort-wiring-propagation] run_id=${capturedRunId} status=${matchedRun?.status ?? "(unknown)"} — ` +
        `post-abort LangGraph status varies by race; only reachability asserted.`,
    );
  }, 30_000);
});
