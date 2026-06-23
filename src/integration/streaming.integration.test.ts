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
import { isLangGraphReachable, LANGGRAPH_BASE_URL, LANGGRAPH_WORKFLOW } from "./helpers.js";

// ---------------------------------------------------------------------------
// Top-level availability check
// ---------------------------------------------------------------------------
const reachable = await isLangGraphReachable();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!reachable)("dispatchAndStream (integration)", () => {
  const client = new LanggraphClient({ baseUrl: LANGGRAPH_BASE_URL, timeoutMs: 10_000 });

  it("streams a run and fires onRunId + onClose", async () => {
    const threadId = await client.createThread({
      openclaw_integration_test: true,
      when: new Date().toISOString(),
    });

    let capturedRunId: string | null = null;
    let capturedClose: boolean | null = null;
    let capturedEventCount = 0;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("timed out waiting for stream to close"));
      }, 25_000);

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
        handlers: {
          onRunId: (runId) => {
            capturedRunId = runId;
          },
          onEvent: (_body) => {
            capturedEventCount++;
          },
          onError: (err) => {
            clearTimeout(timer);
            reject(new Error(`onError: ${err.message}`));
          },
          onClose: (sawTerminal) => {
            clearTimeout(timer);
            capturedClose = sawTerminal;
            resolve();
          },
        },
      });

      // Safety abort after 20 s
      setTimeout(() => controller.abort(), 20_000);
    });

    // The run ID must have been set before onClose fired
    expect(typeof capturedRunId).toBe("string");
    expect((capturedRunId as unknown as string).length).toBeGreaterThan(0);

    // onClose was called (capturedClose is boolean, not null)
    expect(capturedClose).not.toBeNull();
    expect(typeof capturedClose).toBe("boolean");

    // We tolerate any number of events, including zero (fast/empty workflows)
    expect(capturedEventCount).toBeGreaterThanOrEqual(0);
  }, 30_000); // vitest per-test timeout
});
