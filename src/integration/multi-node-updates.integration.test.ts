/**
 * Integration test: multi-node updates frame — parallel branch behavior.
 *
 * Documents how the bridge handles an updates SSE frame that contains deltas
 * from multiple nodes (i.e. when LangGraph fans out to parallel branches and
 * reports both branch deltas in a single frame).
 *
 * Observed behavior (recorded 2026-06-24, LangGraph 0.10.0 / langgraph-py 1.2.6):
 *   When the multi-node-stub graph fans out from "fanout" to "branch_a" and
 *   "branch_b" in parallel, LangGraph emits FOUR separate updates frames — one
 *   per node (fanout, branch_a, branch_b, joinup) — rather than batching the
 *   parallel branches into a single frame. The bridge therefore emits 4 milestone
 *   events total.
 *
 *   If a future LangGraph version batches parallel branches into one frame,
 *   the bridge's first-node-only ack path (event-subscriber.ts ~line 111)
 *   would suppress branch_b's milestone. This test is the forcing function to
 *   catch that regression — it will fail on the milestone count, prompting a
 *   deliberate decision about the bridge's multi-key frame handling.
 *
 * Skipped silently when the server isn't reachable. The multi-node-stub
 * assistant (graph_id "multi-node-stub") must be registered — see
 * examples/multi-node-stub-graph/README.md.
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

const MULTI_NODE_WORKFLOW = process.env.LANGGRAPH_MULTI_NODE_WORKFLOW ?? "multi-node-stub";

async function isMultiNodeStubReachable(timeoutMs = 2000): Promise<boolean> {
  if (!(await isLangGraphReachable())) return false;
  try {
    const res = await fetch(`${LANGGRAPH_BASE_URL}/assistants/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(LANGGRAPH_API_KEY ? { "x-api-key": LANGGRAPH_API_KEY } : {}),
        ...(LANGGRAPH_API_KEY && LANGGRAPH_AUTH_SCHEME
          ? { "x-auth-scheme": LANGGRAPH_AUTH_SCHEME }
          : {}),
      },
      body: JSON.stringify({ graph_id: MULTI_NODE_WORKFLOW, limit: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const matches = (await res.json()) as Array<{ assistant_id: string }>;
    if (!Array.isArray(matches) || matches.length === 0) {
      console.warn(
        `[integration] LangGraph reachable but assistant '${MULTI_NODE_WORKFLOW}' not found — ` +
          `skipping multi-node integration tests. To register: ` +
          `cd examples/integration-test-graph && langgraph dev --no-browser. ` +
          `Or override: LANGGRAPH_MULTI_NODE_WORKFLOW=<id>.`,
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

const reachable = await isMultiNodeStubReachable();

describe.skipIf(!reachable)("multi-node updates frame (integration)", () => {
  const client = new LanggraphClient({
    baseUrl: LANGGRAPH_BASE_URL,
    timeoutMs: 10_000,
    apiKey: LANGGRAPH_API_KEY,
    authScheme: LANGGRAPH_AUTH_SCHEME,
  });

  it("parallel fan-out graph → bridge emits milestone per branch + final state correct", async () => {
    const threadId = await client.createThread({
      openclaw_integration_test: true,
      test: "multi-node-updates",
      when: new Date().toISOString(),
    });

    const milestones: Array<{ node?: string; [k: string]: unknown }> = [];
    let closedClean = false;
    let runId: string | null = null;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("multi-node dispatch timed out"));
      }, 25_000);
      let controller: AbortController | null = null;

      const cleanup = () => {
        clearTimeout(timer);
        controller?.abort();
      };

      controller = dispatchAndStream({
        baseUrl: LANGGRAPH_BASE_URL,
        threadId,
        flowId: "multi-node-integration",
        assistantId: MULTI_NODE_WORKFLOW,
        input: {},
        apiKey: LANGGRAPH_API_KEY,
        authScheme: LANGGRAPH_AUTH_SCHEME,
        metadata: {
          openclaw_integration_test: true,
          openclaw_flow_id: "multi-node-integration",
          openclaw_session_key: "multi-node-integration-session",
        },
        handlers: {
          onRunId: (id) => {
            runId = id;
          },
          onEvent: (body) => {
            if (body.kind === "milestone") {
              milestones.push(body as { node?: string; [k: string]: unknown });
            }
          },
          onError: (err) => {
            cleanup();
            reject(new Error(`onError: ${err.message}`));
          },
          onClose: () => {
            closedClean = true;
            cleanup();
            resolve();
          },
        },
      });
    });

    // Basic liveness
    expect(typeof runId).toBe("string");
    expect(closedClean).toBe(true);

    // --- Documented observed behavior (2026-06-24, LangGraph 0.10.0 / langgraph-py 1.2.6) ---
    //
    // LangGraph emits FOUR separate updates frames for this graph:
    //   fanout → branch_a → branch_b → joinup  (one frame each = 4 milestones)
    // Parallel branches are NOT batched into a single frame at this version.
    //
    // If a future LangGraph version batches parallel branches into one frame,
    // the bridge's first-node-only ack path (event-subscriber.ts ~line 111)
    // would suppress branch_b. This assertion will fail, forcing deliberate
    // handling of the multi-key frame case.
    expect(milestones.length).toBe(4);

    // Extract node names from the milestone data payload (shape: {kind, data: {node, delta}})
    const nodeNames = milestones.map(
      (m) => (m["data"] as { node?: string } | undefined)?.node ?? m["title"] ?? "(unknown)",
    );
    console.info(
      `[multi-node-updates] milestone count: ${milestones.length}. ` +
        `nodes seen: ${nodeNames.join(", ")}`,
    );

    // --- Final thread state: both branches joined correctly ---
    //
    // This is the load-bearing assertion: regardless of how many milestones
    // the bridge emitted, the LangGraph state must show that both branches
    // ran and the join was correct.
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
      values: { branches?: string[]; final?: string };
    };

    // Both branches must have run
    expect(Array.isArray(threadState.values.branches)).toBe(true);
    expect(threadState.values.branches).toContain("a");
    expect(threadState.values.branches).toContain("b");

    // joinup must have produced the correct final string
    expect(threadState.values.final).toBe("joined:a,b");
  }, 60_000);
});
