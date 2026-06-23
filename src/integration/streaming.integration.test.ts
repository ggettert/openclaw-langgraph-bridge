/**
 * Integration test: dispatchAndStream SSE subscriber.
 *
 * Creates a thread then dispatches a workflow run via `dispatchAndStream`,
 * asserting that:
 *   - the `onRunId` callback fires with a valid run ID
 *   - the stream closes cleanly (or times out gracefully)
 *
 * The whole describe block is skipped when LangGraph is unreachable, so
 * `npm test` (unit-only) stays clean.
 *
 * Run with a real server:
 *   LANGGRAPH_BASE_URL=http://localhost:2024 npm run test:integration
 *
 * Originally derived from scripts/smoke-streaming.ts.
 */

import { describe, it, expect } from "vitest";
import { dispatchAndStream } from "../event-subscriber.js";
import { LanggraphClient } from "../langgraph-client.js";
import {
  isLangGraphReachable,
  LANGGRAPH_BASE_URL,
  LANGGRAPH_WORKFLOW,
  LANGGRAPH_API_KEY,
  LANGGRAPH_AUTH_SCHEME,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Top-level availability check
// ---------------------------------------------------------------------------
const reachable = await isLangGraphReachable();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!reachable)("dispatchAndStream (integration)", () => {
  const client = new LanggraphClient({
    baseUrl: LANGGRAPH_BASE_URL,
    timeoutMs: 10_000,
    ...(LANGGRAPH_API_KEY && { apiKey: LANGGRAPH_API_KEY }),
    ...(LANGGRAPH_AUTH_SCHEME && { authScheme: LANGGRAPH_AUTH_SCHEME }),
  });

  it("streams a run and fires onRunId + onClose", async () => {
    const threadId = await client.createThread({
      openclaw_integration_test: true,
      when: new Date().toISOString(),
    });

    let capturedRunId: string | null = null;
    let capturedClose: boolean | null = null;

    await new Promise<void>((resolve, reject) => {
      // Outer reject timer — cleared in every exit path to avoid leaks.
      const rejectTimer = setTimeout(() => {
        reject(new Error("timed out waiting for stream to close"));
      }, 25_000);

      // Safety abort after 20 s — also cleared in every exit path.
      const abortTimer = setTimeout(() => controller.abort(), 20_000);

      const clearTimers = () => {
        clearTimeout(rejectTimer);
        clearTimeout(abortTimer);
      };

      const controller = dispatchAndStream({
        baseUrl: LANGGRAPH_BASE_URL,
        threadId,
        flowId: "integration-no-flow",
        assistantId: LANGGRAPH_WORKFLOW,
        input: { integration_test: "streaming" },
        metadata: {
          openclaw_integration_test: true,
          openclaw_flow_id: "integration-no-flow",
          openclaw_session_key: "integration-session",
        },
        ...(LANGGRAPH_API_KEY && { apiKey: LANGGRAPH_API_KEY }),
        ...(LANGGRAPH_AUTH_SCHEME && { authScheme: LANGGRAPH_AUTH_SCHEME }),
        handlers: {
          onRunId: (runId) => {
            capturedRunId = runId;
          },
          onEvent: (_body) => {
            // Event count not asserted — zero events is valid for fast/empty workflows.
            void _body;
          },
          onError: (err) => {
            clearTimers();
            reject(new Error(`onError: ${err.message}`));
          },
          onClose: (sawTerminal) => {
            clearTimers();
            capturedClose = sawTerminal;
            resolve();
          },
        },
      });
    });

    // The run ID must have been set before onClose fired.
    expect(capturedRunId).not.toBeNull();
    expect(capturedRunId!.length).toBeGreaterThan(0);

    // onClose was called (capturedClose is boolean, not null)
    expect(capturedClose).not.toBeNull();
    expect(typeof capturedClose).toBe("boolean");

    // capturedEventCount: no assertion — zero events is valid for fast/empty workflows.
  }, 30_000); // vitest per-test timeout
});
