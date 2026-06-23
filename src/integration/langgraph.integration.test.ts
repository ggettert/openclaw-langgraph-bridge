/**
 * Integration test: LangGraph client wire path.
 *
 * Exercises the HTTP client (liveness, info, create-thread, create-run) against
 * a real LangGraph server. The whole describe block is skipped when the server
 * is unreachable, so `npm test` (unit-only) stays clean.
 *
 * Run with a real server:
 *   LANGGRAPH_BASE_URL=http://localhost:2024 npm run test:integration
 *
 * Originally derived from scripts/smoke-langgraph.ts.
 */

import { describe, it, expect } from "vitest";
import { LanggraphClient } from "../langgraph-client.js";
import { isLangGraphReachable, LANGGRAPH_BASE_URL, LANGGRAPH_WORKFLOW } from "./helpers.js";

// ---------------------------------------------------------------------------
// Top-level availability check (ESM top-level await, supported by vitest)
// ---------------------------------------------------------------------------
const reachable = await isLangGraphReachable();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!reachable)("LangGraph client (integration)", () => {
  const client = new LanggraphClient({ baseUrl: LANGGRAPH_BASE_URL, timeoutMs: 10_000 });

  it("GET /ok returns true", async () => {
    const ok = await client.ok();
    expect(ok).toBe(true);
  });

  it("GET /info returns server metadata", async () => {
    const info = await client.info();
    // info is an opaque JSON object; just assert it's a non-null object
    expect(info).toBeDefined();
    expect(typeof info).toBe("object");
    expect(info).not.toBeNull();
  });

  it("POST /threads creates a thread and returns a non-empty thread_id", async () => {
    const threadId = await client.createThread({
      openclaw_integration_test: true,
      when: new Date().toISOString(),
    });

    expect(typeof threadId).toBe("string");
    expect(threadId.length).toBeGreaterThan(0);
  });

  it("POST /threads/{tid}/runs starts a run and returns a run_id", async () => {
    const threadId = await client.createThread({
      openclaw_integration_test: true,
      when: new Date().toISOString(),
    });

    const run = await client.createRun(threadId, {
      assistantId: LANGGRAPH_WORKFLOW,
      input: { integration_test: "langgraph-client" },
      metadata: {
        openclaw_integration_test: true,
        openclaw_flow_id: "integration-no-flow",
      },
    });

    expect(typeof run.runId).toBe("string");
    expect(run.runId.length).toBeGreaterThan(0);
  });
});
