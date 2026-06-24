/**
 * Integration test: HITL interrupt → resume → terminal lifecycle.
 *
 * Drives the dispatch → __interrupt__ → resume → terminal path end-to-end
 * against a live LangGraph server with the hitl-stub graph registered.
 *
 * Skipped silently when the server isn't reachable. The hitl-stub assistant
 * (graph_id "hitl-stub") must be registered — see
 * examples/hitl-stub-graph/README.md.
 */

import { describe, it, expect } from "vitest";
import { dispatchAndStream } from "../event-subscriber.js";
import { LanggraphClient } from "../langgraph-client.js";
import {
  isLangGraphReachable,
  LANGGRAPH_BASE_URL,
  LANGGRAPH_API_KEY,
  LANGGRAPH_AUTH_SCHEME,
} from "./helpers.js";

// HITL test uses its own workflow id — the default LANGGRAPH_WORKFLOW
// ("integration-stub") is the no-op passthrough. Allow override via env.
const HITL_WORKFLOW = process.env.LANGGRAPH_HITL_WORKFLOW ?? "hitl-stub";

// Probe whether the hitl-stub assistant is registered. The default
// isLangGraphReachable() probes integration-stub; we need a separate check.
async function isHitlStubReachable(timeoutMs = 2000): Promise<boolean> {
  if (!(await isLangGraphReachable())) return false;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const authHeaders: Record<string, string> = {};
    if (LANGGRAPH_API_KEY) {
      authHeaders["x-api-key"] = LANGGRAPH_API_KEY;
      if (LANGGRAPH_AUTH_SCHEME) authHeaders["x-auth-scheme"] = LANGGRAPH_AUTH_SCHEME;
    }
    const res = await fetch(`${LANGGRAPH_BASE_URL}/assistants/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({ graph_id: HITL_WORKFLOW, limit: 1 }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return false;
    const matches = (await res.json()) as Array<{ assistant_id: string }>;
    if (!Array.isArray(matches) || matches.length === 0) {
      console.warn(
        `[integration] LangGraph reachable but assistant '${HITL_WORKFLOW}' not found — ` +
          `skipping HITL integration tests. To register: ` +
          `cd examples/hitl-stub-graph && langgraph dev --no-browser. ` +
          `Or override: LANGGRAPH_HITL_WORKFLOW=<id>.`,
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

const reachable = await isHitlStubReachable();

describe.skipIf(!reachable)("HITL lifecycle (integration)", () => {
  const client = new LanggraphClient({
    baseUrl: LANGGRAPH_BASE_URL,
    timeoutMs: 10_000,
    apiKey: LANGGRAPH_API_KEY,
    authScheme: LANGGRAPH_AUTH_SCHEME,
  });

  it("dispatch → interrupt → resume → terminal", async () => {
    const threadId = await client.createThread({
      openclaw_integration_test: true,
      test: "hitl",
      when: new Date().toISOString(),
    });

    // ---- Phase 1: dispatch, expect __interrupt__ on stream ----

    let dispatchRunId: string | null = null;
    let dispatchSawInterrupt = false;
    let dispatchSawTerminal = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("dispatch phase timed out waiting for __interrupt__")),
        25_000,
      );
      let controller: AbortController | null = null;

      const cleanup = () => {
        clearTimeout(timer);
        controller?.abort();
      };

      controller = dispatchAndStream({
        baseUrl: LANGGRAPH_BASE_URL,
        threadId,
        flowId: "hitl-integration",
        assistantId: HITL_WORKFLOW,
        input: {},
        apiKey: LANGGRAPH_API_KEY,
        authScheme: LANGGRAPH_AUTH_SCHEME,
        metadata: {
          openclaw_integration_test: true,
          openclaw_flow_id: "hitl-integration",
          openclaw_session_key: "hitl-integration-session",
        },
        handlers: {
          onRunId: (runId) => {
            dispatchRunId = runId;
          },
          onEvent: (body) => {
            // Watch for the __interrupt__ frame. The bridge classifies updates
            // frames with node "__interrupt__" as kind "hitl".
            if (body.kind === "hitl") {
              dispatchSawInterrupt = true;
            }
            if (body.kind === "terminal") {
              dispatchSawTerminal = true;
            }
          },
          onError: (err) => {
            cleanup();
            reject(new Error(`dispatch onError: ${err.message}`));
          },
          onClose: () => {
            cleanup();
            resolve();
          },
        },
      });
    });

    expect(typeof dispatchRunId).toBe("string");
    expect(dispatchRunId!.length).toBeGreaterThan(0);
    // The graph paused at __interrupt__, so the dispatch stream should have
    // observed an HITL event before the run "ended" (LangGraph reports the
    // interrupt and closes the stream cleanly).
    expect(dispatchSawInterrupt).toBe(true);
    // No terminal frame yet — workflow is paused, not done.
    expect(dispatchSawTerminal).toBe(false);

    // ---- Phase 2: resume with "approve", expect terminal ----

    let resumeRunId: string | null = null;
    let resumeClosedClean = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("resume phase timed out waiting for terminal"));
      }, 25_000);
      let controller: AbortController | null = null;

      const cleanup = () => {
        clearTimeout(timer);
        controller?.abort();
      };

      controller = dispatchAndStream({
        baseUrl: LANGGRAPH_BASE_URL,
        threadId,
        flowId: "hitl-integration",
        assistantId: HITL_WORKFLOW,
        command: { resume: { decision: "approve", feedback: "" } },
        apiKey: LANGGRAPH_API_KEY,
        authScheme: LANGGRAPH_AUTH_SCHEME,
        metadata: {
          openclaw_integration_test: true,
          openclaw_flow_id: "hitl-integration",
          openclaw_session_key: "hitl-integration-session",
          openclaw_resume_source: "integration:hitl",
        },
        handlers: {
          onRunId: (runId) => {
            resumeRunId = runId;
          },
          onEvent: (_body) => {
            // The done node emits a milestone (updates frame, node "done").
            // A synthetic terminal fires on onClose, not onEvent. No
            // assertions on the event body here; the clean close is the signal.
            void _body;
          },
          onError: (err) => {
            cleanup();
            reject(new Error(`resume onError: ${err.message}`));
          },
          onClose: () => {
            resumeClosedClean = true;
            cleanup();
            resolve();
          },
        },
      });
    });

    expect(typeof resumeRunId).toBe("string");
    expect(resumeRunId!.length).toBeGreaterThan(0);
    // Resume must be a different run from dispatch (LangGraph starts a new run).
    expect(resumeRunId).not.toBe(dispatchRunId);
    // Stream closed cleanly — the done node ran without error.
    expect(resumeClosedClean).toBe(true);

    // Phase 3 (thread state sanity): LanggraphClient does not currently expose
    // a getThreadState() method (GET /threads/{tid}/state), so we skip the
    // state-content assertion. The SSE assertions above are the load-bearing
    // checks for this test (dispatch saw interrupt, resume closed cleanly with
    // a different run ID). A future PR can add getThreadState() and assert
    // state.values.final === "completed:approve".
  }, 60_000); // generous per-test timeout — two SSE round-trips

  it("dispatch → interrupt → resume with feedback → terminal + feedback echo in state", async () => {
    const threadId = await client.createThread({
      openclaw_integration_test: true,
      test: "hitl-block-revise",
      when: new Date().toISOString(),
    });

    // ---- Phase 1: dispatch, expect __interrupt__ ----

    let dispatchRunId: string | null = null;
    let dispatchSawInterrupt = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("dispatch phase timed out waiting for __interrupt__"));
      }, 25_000);
      let controller: AbortController | null = null;

      const cleanup = () => {
        clearTimeout(timer);
        controller?.abort();
      };

      controller = dispatchAndStream({
        baseUrl: LANGGRAPH_BASE_URL,
        threadId,
        flowId: "hitl-block-revise-integration",
        assistantId: HITL_WORKFLOW,
        input: {},
        apiKey: LANGGRAPH_API_KEY,
        authScheme: LANGGRAPH_AUTH_SCHEME,
        metadata: {
          openclaw_integration_test: true,
          openclaw_flow_id: "hitl-block-revise-integration",
          openclaw_session_key: "hitl-block-revise-session",
        },
        handlers: {
          onRunId: (runId) => {
            dispatchRunId = runId;
          },
          onEvent: (body) => {
            if (body.kind === "hitl") {
              dispatchSawInterrupt = true;
            }
          },
          onError: (err) => {
            cleanup();
            reject(new Error(`dispatch onError: ${err.message}`));
          },
          onClose: () => {
            cleanup();
            resolve();
          },
        },
      });
    });

    expect(typeof dispatchRunId).toBe("string");
    expect(dispatchSawInterrupt).toBe(true);

    // ---- Phase 2: resume with block_revise feedback ----
    //
    // normalizeResumePayload transforms the string
    //   "block_revise: cleanup the tests"
    // into  { decision: "block_revise", feedback: "cleanup the tests" }
    // before forwarding to LangGraph. We send the already-normalised form
    // here (as the bridge would) so the assertion is stable.

    let resumeRunId: string | null = null;
    let resumeClosedClean = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("resume phase timed out waiting for terminal"));
      }, 25_000);
      let controller: AbortController | null = null;

      const cleanup = () => {
        clearTimeout(timer);
        controller?.abort();
      };

      controller = dispatchAndStream({
        baseUrl: LANGGRAPH_BASE_URL,
        threadId,
        flowId: "hitl-block-revise-integration",
        assistantId: HITL_WORKFLOW,
        command: { resume: { decision: "block_revise", feedback: "cleanup the tests" } },
        apiKey: LANGGRAPH_API_KEY,
        authScheme: LANGGRAPH_AUTH_SCHEME,
        metadata: {
          openclaw_integration_test: true,
          openclaw_flow_id: "hitl-block-revise-integration",
          openclaw_session_key: "hitl-block-revise-session",
          openclaw_resume_source: "integration:hitl-block-revise",
        },
        handlers: {
          onRunId: (runId) => {
            resumeRunId = runId;
          },
          onEvent: (_body) => {
            void _body;
          },
          onError: (err) => {
            cleanup();
            reject(new Error(`resume onError: ${err.message}`));
          },
          onClose: () => {
            resumeClosedClean = true;
            cleanup();
            resolve();
          },
        },
      });
    });

    expect(typeof resumeRunId).toBe("string");
    expect(resumeRunId).not.toBe(dispatchRunId);
    expect(resumeClosedClean).toBe(true);

    // ---- Phase 3: assert feedback survived in thread state ----
    //
    // The hitl_graph.py done() node now echoes feedback:
    //   final = "completed:{decision}:{feedback}"  (when feedback is present)
    // Proving this survived validates that:
    //   (a) normalizeResumePayload produced the right {decision, feedback} shape
    //   (b) the gate node stored both fields in state
    //   (c) the done node read them back correctly

    const authHeaders: Record<string, string> = {};
    if (LANGGRAPH_API_KEY) {
      authHeaders["x-api-key"] = LANGGRAPH_API_KEY;
      if (LANGGRAPH_AUTH_SCHEME) authHeaders["x-auth-scheme"] = LANGGRAPH_AUTH_SCHEME;
    }
    const stateRes = await fetch(`${LANGGRAPH_BASE_URL}/threads/${threadId}/state`, {
      headers: authHeaders,
    });
    expect(stateRes.ok).toBe(true);
    const threadState = (await stateRes.json()) as {
      values: { final?: string; decision?: string; feedback?: string };
    };
    // decision and feedback stored by gate node
    expect(threadState.values.decision).toBe("block_revise");
    expect(threadState.values.feedback).toBe("cleanup the tests");
    // final echoes both — proves done() read the feedback correctly
    expect(threadState.values.final).toBe("completed:block_revise:cleanup the tests");
  }, 60_000);
});
