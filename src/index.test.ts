import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry from "./index.js";

/**
 * Phase 2 onward, we ship via definePluginEntry (not defineToolPlugin),
 * so the upstream `openclaw plugins build` builder can't introspect the
 * entry — we hand-maintain `openclaw.plugin.json`. These tests assert
 * the bare shape we DO control programmatically.
 */
describe("openclaw-langgraph-bridge entry", () => {
  it("identifies as openclaw-langgraph-bridge", () => {
    expect(entry.id).toBe("openclaw-langgraph-bridge");
  });

  it("exposes a register function", () => {
    expect(typeof entry.register).toBe("function");
  });
});

/**
 * #7: When langgraph_dispatch fails (e.g. LangGraph is unreachable), the
 * plugin must tombstone the created flow so it doesn't linger as 'queued'.
 * This test registers the plugin against a mock api, invokes the dispatch
 * tool with a failing fetch, and asserts that flows.finish() was called
 * with terminal_title='dispatch_failed'.
 */
describe("langgraph_dispatch — dispatch failure tombstones flow (#7)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("tombstones orphaned flow when createThread fetch rejects", async () => {
    const finishedFlows: unknown[] = [];
    const mockFlow = { flowId: "flow-orphan-1", revision: 0 };

    const mockFlowsBinding = {
      createManaged: vi.fn(() => mockFlow),
      resume: vi.fn(),
      get: vi.fn(() => mockFlow),
      finish: vi.fn((args: unknown) => { finishedFlows.push(args); }),
      setWaiting: vi.fn(),
      runTask: vi.fn(),
      findLatest: vi.fn(() => null),
      getTaskSummary: vi.fn(() => null),
    };

    // Capture the dispatch tool's execute function when register() wires it up.
    let dispatchExecute: ((id: string, params: unknown) => Promise<unknown>) | undefined;

    const mockApi = {
      logger: null,
      pluginConfig: {
        langgraphBaseUrl: "http://lg.test:2024",
        callbackToken: "tok-abc",
        agentId: "main",
      },
      runtime: {
        tasks: {
          managedFlows: {
            fromToolContext: vi.fn(() => mockFlowsBinding),
            bindSession: vi.fn(() => mockFlowsBinding),
          },
        },
      },
      // Capture langgraph_dispatch's execute when registered.
      registerTool: vi.fn((factory: (ctx: unknown) => { name: string; execute: unknown }) => {
        const toolDef = factory({ sessionKey: "agent:main:dm:u1", deliveryContext: {} });
        if (toolDef.name === "langgraph_dispatch") {
          dispatchExecute = toolDef.execute as typeof dispatchExecute;
        }
      }),
      registerHttpRoute: vi.fn(),
    };

    // Register the plugin (captures tool factories).
    entry.register(mockApi as never);
    expect(dispatchExecute).toBeDefined();

    // Mock fetch to reject on createThread (the first network call).
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.reject(new Error("connection refused")),
    ) as typeof fetch;

    // Act: call dispatch with a workflow name.
    const resultPromise = dispatchExecute!("tc-1", { workflow: "fleet" });
    // Advance timers past the run_id timeout so the promise resolves.
    vi.advanceTimersByTime(15_000);
    const result = await resultPromise;

    // Assert: error returned to agent.
    // `.details` is reliable: `jsonResult(payload)` calls `textResult(text, payload)` which
    // returns `{ content: [...], details: payload }`. The payload is always placed at `.details`
    // by the SDK — this is a stable contract (see openclaw/dist/common*.js `textResult`).
    expect((result as { details?: { status?: string } }))
      .toMatchObject({ details: { status: "error" } });

    // Assert: orphaned flow tombstoned — flows.finish was called.
    expect(mockFlowsBinding.finish).toHaveBeenCalledOnce();
    const finishArg = finishedFlows[0] as {
      flowId: string;
      stateJson?: { terminal_title?: string; terminal_summary?: string };
    };
    expect(finishArg.flowId).toBe("flow-orphan-1");
    expect(finishArg.stateJson?.terminal_title).toBe("dispatch_failed");
  });
});
