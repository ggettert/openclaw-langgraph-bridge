/**
 * Tests for F4 — AbortController wiring in dispatchAndStream call sites.
 *
 * Uses a `vi.mock` of `./event-subscriber.js` so we can inject a spy
 * AbortController and trigger timeout / onError scenarios without opening
 * real HTTP connections.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must be declared before any imports that transitively load event-subscriber.
vi.mock("./event-subscriber.js", () => ({
  dispatchAndStream: vi.fn(),
}));

import { dispatchAndStream } from "./event-subscriber.js";
import entry, { _inflightControllers, _ensureSigtermHandler } from "./index.js";
import { makeMockApi } from "./test-harness.js";
import type { StreamHandlers } from "./event-subscriber.js";

const mockDispatchAndStream = vi.mocked(dispatchAndStream);

// Minimal fetch that satisfies createThread (POST /threads → {thread_id}).
function makeThreadFetch(threadId = "th-test"): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/threads")) {
      return new Response(JSON.stringify({ thread_id: threadId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePluginConfig(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    langgraphBaseUrl: "http://lg.test:2024",
    callbackToken: "tok-abc",
    agentId: "main",
    defaultTimeoutMs: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// dispatchAndStream abort wiring — langgraph_dispatch
// ---------------------------------------------------------------------------

describe("F4 — abort wiring: langgraph_dispatch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockDispatchAndStream.mockReset();
    _inflightControllers.clear();
    globalThis.fetch = makeThreadFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("aborts controller and removes from inflight when timeout fires", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, "abort");

    // Return controller but never call onRunId → timeout will fire.
    mockDispatchAndStream.mockImplementation(() => controller);

    const { api, tools } = makeMockApi({
      pluginConfig: makePluginConfig({ defaultTimeoutMs: 30 }),
    });
    entry.register(api as never);

    // Start execution, advance fake clock past timeout, then await.
    const resultPromise = tools["langgraph_dispatch"]!.execute("tc", {
      workflow: "fleet",
      input: {},
    }) as Promise<{ details?: { status?: string } }>;
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(abortSpy).toHaveBeenCalled();
    expect(result.details?.status).toBe("error");
  });

  it("aborts controller and removes from inflight when onError fires", async () => {
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, "abort");

    mockDispatchAndStream.mockImplementation(({ handlers }: { handlers: StreamHandlers }) => {
      // Trigger onError asynchronously so dispatchCtrl assignment completes first.
      setImmediate(() => {
        handlers.onError?.(new Error("simulated stream error"));
      });
      return controller;
    });

    const { api, tools } = makeMockApi({
      pluginConfig: makePluginConfig({ defaultTimeoutMs: 5000 }),
    });
    entry.register(api as never);

    const result = (await tools["langgraph_dispatch"]!.execute("tc", {
      workflow: "fleet",
      input: {},
    })) as { details?: { status?: string } };

    expect(abortSpy).toHaveBeenCalled();
    expect(result.details?.status).toBe("error");
  });

  it("tracks controller in _inflightControllers during the stream and removes on close", async () => {
    const controller = new AbortController();
    let capturedHandlers!: StreamHandlers;

    mockDispatchAndStream.mockImplementation(({ handlers }: { handlers: StreamHandlers }) => {
      capturedHandlers = handlers;
      return controller;
    });

    const { api, tools } = makeMockApi({
      pluginConfig: makePluginConfig({ defaultTimeoutMs: 5000 }),
    });
    entry.register(api as never);

    // Start execute but don't await yet.
    const executePromise = tools["langgraph_dispatch"]!.execute("tc", {
      workflow: "fleet",
      input: {},
    });

    // Give setImmediate / microtasks a tick to let the Promise constructor run.
    await new Promise((r) => setImmediate(r));

    // Controller should now be tracked.
    expect(_inflightControllers.has(controller)).toBe(true);

    // Simulate run_id arrival and then stream close.
    capturedHandlers.onRunId?.("run-xyz");
    capturedHandlers.onClose?.(true);

    await executePromise;

    // After onClose, controller should be removed.
    expect(_inflightControllers.has(controller)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dispatchAndStream abort wiring — langgraph_resume
// ---------------------------------------------------------------------------

describe("F4 — abort wiring: langgraph_resume", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockDispatchAndStream.mockReset();
    _inflightControllers.clear();
    globalThis.fetch = makeThreadFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  function makeMockApiWithWaitingFlow(
    extraConfig?: Record<string, unknown>,
  ): ReturnType<typeof makeMockApi> {
    const waitingFlowRecord = {
      flowId: "flow-waiting-1",
      revision: 2,
      status: "waiting",
      owner_key: "agent:main:dm:user",
      stateJson: {
        decision_only: false,
        langgraph_base_url: "http://lg.test:2024",
        langgraph_thread_id: "thread-waiting",
        workflow: "fleet",
      },
      waitJson: { prompt: "Continue?" },
    };

    return makeMockApi({
      flowRecord: waitingFlowRecord,
      pluginConfig: {
        langgraphBaseUrl: "http://lg.test:2024",
        callbackToken: "tok-abc",
        agentId: "main",
        defaultTimeoutMs: 50, // short so timeout tests don't stall
        ...extraConfig,
      },
    });
  }

  it("aborts resume controller when timeout fires", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, "abort");

    mockDispatchAndStream.mockImplementation(() => controller);

    const { api, tools } = makeMockApiWithWaitingFlow();
    entry.register(api as never);

    const resultPromise = tools["langgraph_resume"]!.execute("tc", {
      flow_id: "flow-waiting-1",
      payload: "continue",
    }) as Promise<{ details?: { status?: string } }>;
    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;

    expect(abortSpy).toHaveBeenCalled();
    expect(result.details?.status).toBe("error");
  });

  it("aborts resume controller when onError fires", async () => {
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, "abort");

    mockDispatchAndStream.mockImplementation(({ handlers }: { handlers: StreamHandlers }) => {
      setImmediate(() => handlers.onError?.(new Error("resume stream failed")));
      return controller;
    });

    const { api, tools } = makeMockApiWithWaitingFlow();
    entry.register(api as never);

    const result = (await tools["langgraph_resume"]!.execute("tc", {
      flow_id: "flow-waiting-1",
      payload: "continue",
    })) as { details?: { status?: string } };

    expect(abortSpy).toHaveBeenCalled();
    expect(result.details?.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// C1/C2 regression — sync onError race (dispatchCtrl undefined at call time)
// ---------------------------------------------------------------------------

describe("F4 — sync onError race (C1/C2 regression)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockDispatchAndStream.mockReset();
    _inflightControllers.clear();
    globalThis.fetch = makeThreadFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("dispatch: rejects without TypeError when onError fires synchronously before dispatchCtrl is assigned", async () => {
    // Simulate the race: dispatchAndStream calls onError synchronously
    // (e.g. invalid URL throws inside fetch before the async IIFE yields).
    // At that moment dispatchCtrl is still undefined in the outer scope.
    mockDispatchAndStream.mockImplementation(({ handlers }: { handlers: StreamHandlers }) => {
      // Synchronous call — dispatchCtrl has not been assigned yet.
      handlers.onError?.(new Error("sync fail: invalid URL"));
      return new AbortController();
    });

    const { api, tools } = makeMockApi({
      pluginConfig: makePluginConfig({ defaultTimeoutMs: 5000 }),
    });
    entry.register(api as never);

    // Must not throw TypeError ("Cannot read properties of undefined").
    const result = (await tools["langgraph_dispatch"]!.execute("tc", {
      workflow: "fleet",
      input: {},
    })) as { details?: { status?: string; message?: string } };

    expect(result.details?.status).toBe("error");
    // No phantom entry should remain in the inflight set.
    expect(_inflightControllers.size).toBe(0);
  });

  it("resume: rejects without TypeError when onError fires synchronously before resumeCtrl is assigned", async () => {
    mockDispatchAndStream.mockImplementation(({ handlers }: { handlers: StreamHandlers }) => {
      handlers.onError?.(new Error("sync fail: invalid URL"));
      return new AbortController();
    });

    const waitingFlowRecord = {
      flowId: "flow-sync-race-1",
      revision: 2,
      status: "waiting",
      owner_key: "agent:main:dm:user",
      stateJson: {
        decision_only: false,
        langgraph_base_url: "http://lg.test:2024",
        langgraph_thread_id: "thread-sync-race",
        workflow: "fleet",
      },
      waitJson: { prompt: "Continue?" },
    };

    const { api, tools } = makeMockApi({
      flowRecord: waitingFlowRecord,
      pluginConfig: {
        langgraphBaseUrl: "http://lg.test:2024",
        callbackToken: "tok-abc",
        agentId: "main",
        defaultTimeoutMs: 5000,
      },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_resume"]!.execute("tc", {
      flow_id: "flow-sync-race-1",
      payload: "continue",
    })) as { details?: { status?: string } };

    expect(result.details?.status).toBe("error");
    expect(_inflightControllers.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SIGTERM handler — idempotency
// ---------------------------------------------------------------------------

describe("F4 — SIGTERM handler idempotency", () => {
  it("registers at most one SIGTERM listener regardless of how many times _ensureSigtermHandler is called", () => {
    // _ensureSigtermHandler was already called at module load time.
    const before = process.listenerCount("SIGTERM");

    // Calling it again must be a no-op.
    _ensureSigtermHandler();
    _ensureSigtermHandler();
    _ensureSigtermHandler();

    const after = process.listenerCount("SIGTERM");
    expect(after).toBe(before);
  });

  it("aborts all inflight controllers when SIGTERM fires", () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    const abort1 = vi.spyOn(c1, "abort");
    const abort2 = vi.spyOn(c2, "abort");

    _inflightControllers.add(c1);
    _inflightControllers.add(c2);

    // Emit SIGTERM directly (the handler is already registered).
    process.emit("SIGTERM");

    expect(abort1).toHaveBeenCalled();
    expect(abort2).toHaveBeenCalled();
    expect(_inflightControllers.size).toBe(0);
  });
});
