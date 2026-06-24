import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import entry, { ConfigSchema } from "./index.js";
import { makeMockApi, makeFakeFlowRecord } from "./test-harness.js";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an SSE ReadableStream that emits one metadata frame then closes. */
function makeSseStream(runId = "run-test-1"): ReadableStream {
  const frame = `event: metadata\r\ndata: ${JSON.stringify({ run_id: runId, attempt: 1 })}\r\n\r\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
}

/**
 * Build a fetch mock that handles:
 *   1. POST /threads → { thread_id }
 *   2. POST /threads/.../runs/stream → SSE stream with metadata
 *   3. GET /assistants/.../schemas → schemas
 *   4. POST /assistants/search → assistant list
 */
function makeDispatchFetch(options?: {
  threadId?: string;
  runId?: string;
  rejectOn?: "createThread" | "stream";
  httpStatus?: number;
}) {
  const threadId = options?.threadId ?? "thread-1";
  const runId = options?.runId ?? "run-1";

  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/threads") && !url.includes("/runs/stream") && !url.includes("search")) {
      // createThread
      if (options?.rejectOn === "createThread") {
        throw new Error("network error on createThread");
      }
      if (options?.httpStatus) {
        return new Response("error body", {
          status: options.httpStatus,
          statusText: "Error",
        });
      }
      return new Response(JSON.stringify({ thread_id: threadId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/runs/stream")) {
      // SSE stream
      if (options?.rejectOn === "stream") {
        throw new Error("network error on stream");
      }
      return new Response(makeSseStream(runId), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.includes("/schemas")) {
      return new Response(JSON.stringify({ input_schema: {}, output_schema: {} }), {
        status: options?.httpStatus ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("assistants/search")) {
      return new Response(
        JSON.stringify([
          { assistant_id: "ast-1", graph_id: "fleet", name: "Fleet", description: null },
          { assistant_id: "ast-2", graph_id: "review", name: "Review", description: "A reviewer" },
        ]),
        {
          status: options?.httpStatus ?? 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });

  return fetchImpl as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// ConfigSchema validation
// ---------------------------------------------------------------------------

describe("ConfigSchema — langgraphApiKey validation", () => {
  it("rejects empty string (minLength: 1)", () => {
    expect(Value.Check(ConfigSchema, { langgraphApiKey: "" })).toBe(false);
  });

  it("rejects whitespace-only string (pattern fails)", () => {
    expect(Value.Check(ConfigSchema, { langgraphApiKey: "   " })).toBe(false);
    expect(Value.Check(ConfigSchema, { langgraphApiKey: "\t" })).toBe(false);
    expect(Value.Check(ConfigSchema, { langgraphApiKey: "\n" })).toBe(false);
  });

  it("rejects pasted curl commands with spaces", () => {
    expect(
      Value.Check(ConfigSchema, { langgraphApiKey: "curl -H 'Authorization: Bearer foo'" }),
    ).toBe(false);
  });

  it("accepts valid API key strings", () => {
    expect(Value.Check(ConfigSchema, { langgraphApiKey: "lsv2_abc123" })).toBe(true);
    expect(Value.Check(ConfigSchema, { langgraphApiKey: "ls__abc.def+ghi/jkl=" })).toBe(true);
  });

  it("accepts config without langgraphApiKey (field is Optional)", () => {
    expect(Value.Check(ConfigSchema, {})).toBe(true);
    expect(Value.Check(ConfigSchema, { langgraphBaseUrl: "http://lg:2024" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// langgraph_inspect
// ---------------------------------------------------------------------------

describe("langgraph_inspect", () => {
  it("returns error when session key is missing", async () => {
    const { api, tools } = makeMockApi({ sessionKey: "" });
    entry.register(api as never);

    const result = (await tools["langgraph_inspect"]!.execute("tc", {})) as {
      details?: { status?: string; reason?: string };
    };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("missing_session_key");
  });

  it("returns inspect with null flow when no flows exist", async () => {
    const { api, tools, flowsBinding } = makeMockApi();
    flowsBinding.findLatest.mockReturnValue(null);
    flowsBinding.get.mockReturnValue(undefined);
    entry.register(api as never);

    const result = (await tools["langgraph_inspect"]!.execute("tc", {})) as {
      details?: { status?: string; inspect?: unknown };
    };
    expect(result.details?.status).toBe("ok");
    expect(result.details?.inspect).toBeDefined();
  });

  it("returns inspect for latest flow when no flow_id given", async () => {
    const flowRecord = makeFakeFlowRecord({
      flowId: "flow-abc",
      revision: 3,
      status: "running",
    });
    const { api, tools } = makeMockApi({ flowRecord });
    entry.register(api as never);

    const result = (await tools["langgraph_inspect"]!.execute("tc", {})) as {
      details?: { status?: string; inspect?: unknown };
    };
    expect(result.details?.status).toBe("ok");
    expect(result.details?.inspect).toBeDefined();
  });

  it("returns inspect for a specific flow_id", async () => {
    const flowRecord = makeFakeFlowRecord({ flowId: "flow-xyz", revision: 2 });
    const { api, tools } = makeMockApi({ flowRecord });
    entry.register(api as never);

    const result = (await tools["langgraph_inspect"]!.execute("tc", {
      flow_id: "flow-xyz",
    })) as { details?: { status?: string } };
    expect(result.details?.status).toBe("ok");
  });

  it("returns error when inspect throws", async () => {
    const { api, tools, flowsBinding } = makeMockApi();
    flowsBinding.findLatest.mockImplementation(() => {
      throw new Error("db connection error");
    });
    entry.register(api as never);

    const result = (await tools["langgraph_inspect"]!.execute("tc", {})) as {
      details?: { status?: string; reason?: string; message?: string };
    };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("inspect_failed");
    expect(result.details?.message).toContain("db connection error");
  });
});

// ---------------------------------------------------------------------------
// langgraph_inspect_workflow
// ---------------------------------------------------------------------------

describe("langgraph_inspect_workflow", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns error when langgraphBaseUrl is not configured", async () => {
    const { api, tools } = makeMockApi({
      pluginConfig: { callbackToken: "tok" }, // no langgraphBaseUrl
    });
    entry.register(api as never);

    const result = (await tools["langgraph_inspect_workflow"]!.execute("tc", {
      workflow_id: "fleet",
    })) as { details?: { status?: string; reason?: string } };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("missing_langgraph_base_url");
  });

  it("returns error when workflow not in allowedWorkflows", async () => {
    const { api, tools } = makeMockApi({
      pluginConfig: {
        langgraphBaseUrl: "http://lg.test:2024",
        allowedWorkflows: ["fleet"],
      },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_inspect_workflow"]!.execute("tc", {
      workflow_id: "unauthorized-workflow",
    })) as { details?: { status?: string; reason?: string } };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("workflow_not_allowed");
  });

  it("allows workflow when in allowedWorkflows", async () => {
    globalThis.fetch = makeDispatchFetch();
    const { api, tools } = makeMockApi({
      pluginConfig: {
        langgraphBaseUrl: "http://lg.test:2024",
        allowedWorkflows: ["fleet"],
      },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_inspect_workflow"]!.execute("tc", {
      workflow_id: "fleet",
    })) as { details?: { status?: string } };
    expect(result.details?.status).toBe("ok");
  });

  it("returns ok with schemas on success", async () => {
    globalThis.fetch = makeDispatchFetch();
    const { api, tools } = makeMockApi({
      pluginConfig: { langgraphBaseUrl: "http://lg.test:2024" },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_inspect_workflow"]!.execute("tc", {
      workflow_id: "fleet",
    })) as {
      details?: { status?: string; workflow_id?: string; schemas?: unknown };
    };
    expect(result.details?.status).toBe("ok");
    expect(result.details?.workflow_id).toBe("fleet");
    expect(result.details?.schemas).toBeDefined();
  });

  it("returns workflow_not_found on 404", async () => {
    globalThis.fetch = makeDispatchFetch({ httpStatus: 404 });
    const { api, tools } = makeMockApi({
      pluginConfig: { langgraphBaseUrl: "http://lg.test:2024" },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_inspect_workflow"]!.execute("tc", {
      workflow_id: "unknown",
    })) as { details?: { status?: string; reason?: string } };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("workflow_not_found");
  });

  it("returns request_failed on network error", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("connection refused"))) as never;
    const { api, tools } = makeMockApi({
      pluginConfig: { langgraphBaseUrl: "http://lg.test:2024" },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_inspect_workflow"]!.execute("tc", {
      workflow_id: "fleet",
    })) as { details?: { status?: string; reason?: string } };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("request_failed");
  });
});

// ---------------------------------------------------------------------------
// langgraph_list_workflows
// ---------------------------------------------------------------------------

describe("langgraph_list_workflows", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns error when langgraphBaseUrl is not configured", async () => {
    const { api, tools } = makeMockApi({ pluginConfig: {} });
    entry.register(api as never);

    const result = (await tools["langgraph_list_workflows"]!.execute("tc", {})) as {
      details?: { status?: string; reason?: string };
    };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("missing_langgraph_base_url");
  });

  it("lists all workflows with allowed=true when no allowlist", async () => {
    globalThis.fetch = makeDispatchFetch();
    const { api, tools } = makeMockApi({
      pluginConfig: { langgraphBaseUrl: "http://lg.test:2024" },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_list_workflows"]!.execute("tc", {})) as {
      details?: {
        status?: string;
        workflows?: Array<{ allowed?: boolean }>;
        allowlist_active?: boolean;
      };
    };
    expect(result.details?.status).toBe("ok");
    expect(result.details?.allowlist_active).toBe(false);
    expect(result.details?.workflows?.every((w) => w.allowed === true)).toBe(true);
  });

  it("marks blocked workflows allowed=false when allowlist is active", async () => {
    globalThis.fetch = makeDispatchFetch();
    const { api, tools } = makeMockApi({
      pluginConfig: {
        langgraphBaseUrl: "http://lg.test:2024",
        allowedWorkflows: ["fleet"], // only fleet is allowed
      },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_list_workflows"]!.execute("tc", {})) as {
      details?: {
        status?: string;
        workflows?: Array<{ assistant_id?: string; graph_id?: string; allowed?: boolean }>;
        allowlist_active?: boolean;
      };
    };
    expect(result.details?.status).toBe("ok");
    expect(result.details?.allowlist_active).toBe(true);
    const fleet = result.details?.workflows?.find((w) => w.graph_id === "fleet");
    const review = result.details?.workflows?.find((w) => w.graph_id === "review");
    expect(fleet?.allowed).toBe(true);
    expect(review?.allowed).toBe(false);
  });

  it("returns request_failed on network error", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("timeout"))) as never;
    const { api, tools } = makeMockApi({
      pluginConfig: { langgraphBaseUrl: "http://lg.test:2024" },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_list_workflows"]!.execute("tc", {})) as {
      details?: { status?: string; reason?: string };
    };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("request_failed");
  });

  it("returns empty workflow list when server returns none", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if ((url as string).includes("assistants/search")) {
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const { api, tools } = makeMockApi({
      pluginConfig: { langgraphBaseUrl: "http://lg.test:2024" },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_list_workflows"]!.execute("tc", {})) as {
      details?: { status?: string; workflows?: unknown[] };
    };
    expect(result.details?.status).toBe("ok");
    expect(result.details?.workflows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// langgraph_dispatch
// ---------------------------------------------------------------------------

describe("langgraph_dispatch — error paths", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns error when langgraphBaseUrl is not configured", async () => {
    const { api, tools } = makeMockApi({ pluginConfig: { callbackToken: "tok" } });
    entry.register(api as never);

    const result = (await tools["langgraph_dispatch"]!.execute("tc", {
      workflow: "fleet",
    })) as { details?: { status?: string; reason?: string } };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("missing_langgraph_base_url");
  });

  it("returns error when session key is missing", async () => {
    const { api, tools } = makeMockApi({
      sessionKey: "",
      pluginConfig: { langgraphBaseUrl: "http://lg.test:2024" },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_dispatch"]!.execute("tc", {
      workflow: "fleet",
    })) as { details?: { status?: string; reason?: string } };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("missing_session_key");
  });

  it("returns error when workflow not in allowedWorkflows", async () => {
    const { api, tools } = makeMockApi({
      pluginConfig: {
        langgraphBaseUrl: "http://lg.test:2024",
        allowedWorkflows: ["fleet"],
      },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_dispatch"]!.execute("tc", {
      workflow: "unauthorized-wf",
    })) as { details?: { status?: string; reason?: string; allowed?: unknown } };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("workflow_not_allowed");
    expect(result.details?.allowed).toEqual(["fleet"]);
  });
});

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
      finish: vi.fn((args: unknown) => {
        finishedFlows.push(args);
      }),
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
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error("connection refused"))) as typeof fetch;

    // Act: call dispatch with a workflow name.
    const resultPromise = dispatchExecute!("tc-1", { workflow: "fleet" });
    // Advance timers past the run_id timeout so the promise resolves.
    vi.advanceTimersByTime(15_000);
    const result = await resultPromise;

    // Assert: error returned to agent.
    expect(result as { details?: { status?: string } }).toMatchObject({
      details: { status: "error" },
    });

    // Assert: orphaned flow tombstoned — flows.finish was called.
    expect(mockFlowsBinding.finish).toHaveBeenCalledOnce();
    const finishArg = finishedFlows[0] as {
      flowId: string;
      stateJson?: { terminal_title?: string; terminal_summary?: string };
    };
    expect(finishArg.flowId).toBe("flow-orphan-1");
    expect(finishArg.stateJson?.terminal_title).toBe("dispatch_failed");
  });

  it("tombstones orphaned flow when stream errors after createThread succeeds", async () => {
    const finishedFlows: unknown[] = [];
    const mockFlow = { flowId: "flow-orphan-2", revision: 0 };

    const mockFlowsBinding = {
      createManaged: vi.fn(() => mockFlow),
      resume: vi.fn(),
      get: vi.fn(() => mockFlow),
      finish: vi.fn((args: unknown) => {
        finishedFlows.push(args);
      }),
      setWaiting: vi.fn(),
      runTask: vi.fn(),
      findLatest: vi.fn(() => null),
      getTaskSummary: vi.fn(() => null),
    };

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
      registerTool: vi.fn((factory: (ctx: unknown) => { name: string; execute: unknown }) => {
        const toolDef = factory({ sessionKey: "agent:main:dm:u1", deliveryContext: {} });
        if (toolDef.name === "langgraph_dispatch") {
          dispatchExecute = toolDef.execute as typeof dispatchExecute;
        }
      }),
      registerHttpRoute: vi.fn(),
    };

    entry.register(mockApi as never);
    expect(dispatchExecute).toBeDefined();

    // Mock fetch:
    //   POST /threads → success returning {thread_id: "tid-x"}
    //   POST /threads/tid-x/runs/stream → fetch resolves but reader throws mid-stream
    //     (before metadata frame so runIdPromise rejects)
    globalThis.fetch = vi.fn(async (url: string) => {
      if ((url as string).includes("/threads") && !(url as string).includes("/runs/stream")) {
        return new Response(JSON.stringify({ thread_id: "tid-x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if ((url as string).includes("/runs/stream")) {
        // Return a stream that immediately errors (before metadata frame)
        const stream = new ReadableStream({
          start(controller) {
            controller.error(new Error("stream error before metadata"));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    // Act: call dispatch; advance timers past the run_id timeout
    const resultPromise = dispatchExecute!("tc-2", { workflow: "fleet" });
    vi.advanceTimersByTime(15_000);
    const result = await resultPromise;

    // Assert: dispatch returns status:"error"
    expect(result as { details?: { status?: string } }).toMatchObject({
      details: { status: "error" },
    });

    // Assert: flow is tombstoned (deleted from managedFlows).
    // Note: with the A1 onClose fix, finish may be called twice — once via
    // the synthetic terminal from onClose, and once from the outer catch.
    // In production the second call fails with revision_conflict (caught).
    // Here we assert it was called AT LEAST once and the first call tombstoned.
    expect(mockFlowsBinding.finish).toHaveBeenCalled();
    const finishArg = finishedFlows[0] as {
      flowId: string;
      stateJson?: { terminal_title?: string };
    };
    expect(finishArg.flowId).toBe("flow-orphan-2");
  });
});

describe("langgraph_dispatch — success path", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns accepted with flow_id, thread_id, run_id on success", async () => {
    globalThis.fetch = makeDispatchFetch({ threadId: "th-1", runId: "run-abc" });
    const { api, tools } = makeMockApi({
      pluginConfig: {
        langgraphBaseUrl: "http://lg.test:2024",
        callbackToken: "tok",
        callbackPublicBaseUrl: "http://public.example.com",
      },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_dispatch"]!.execute("tc", {
      workflow: "fleet",
      input: { ticket_id: "T-1" },
      decision_only: true,
    })) as {
      details?: {
        status?: string;
        flow_id?: string;
        langgraph_thread_id?: string;
        langgraph_run_id?: string;
        workflow?: string;
      };
    };
    expect(result.details?.status).toBe("accepted");
    expect(result.details?.langgraph_thread_id).toBe("th-1");
    expect(result.details?.langgraph_run_id).toBe("run-abc");
    expect(result.details?.workflow).toBe("fleet");
    expect(result.details?.flow_id).toBeDefined();
  });

  it("works without callbackPublicBaseUrl (no webhook_url)", async () => {
    globalThis.fetch = makeDispatchFetch();
    const { api, tools } = makeMockApi({
      pluginConfig: {
        langgraphBaseUrl: "http://lg.test:2024",
        // no callbackPublicBaseUrl
      },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_dispatch"]!.execute("tc", {
      workflow: "fleet",
    })) as {
      details?: { status?: string; webhook_url?: string };
    };
    expect(result.details?.status).toBe("accepted");
    expect(result.details?.webhook_url).toContain("not configured");
  });
});

// ---------------------------------------------------------------------------
// langgraph_resume
// ---------------------------------------------------------------------------

describe("langgraph_resume — error paths", () => {
  it("returns error when session key is missing", async () => {
    const { api, tools } = makeMockApi({ sessionKey: "" });
    entry.register(api as never);

    const result = (await tools["langgraph_resume"]!.execute("tc", {
      payload: "approve",
    })) as { details?: { status?: string; reason?: string } };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("missing_session_key");
  });

  it("returns no_flow_found when no flow exists", async () => {
    const { api, tools, flowsBinding } = makeMockApi();
    flowsBinding.findLatest.mockReturnValue(null);
    flowsBinding.get.mockReturnValue(undefined);
    entry.register(api as never);

    const result = (await tools["langgraph_resume"]!.execute("tc", {
      payload: "approve",
    })) as { details?: { status?: string; reason?: string } };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("no_flow_found");
  });

  it("returns flow_not_waiting when flow status is not waiting", async () => {
    const flowRecord = makeFakeFlowRecord({
      flowId: "flow-1",
      status: "running",
      revision: 2,
    });
    const { api, tools } = makeMockApi({ flowRecord });
    entry.register(api as never);

    const result = (await tools["langgraph_resume"]!.execute("tc", {
      payload: "approve",
    })) as { details?: { status?: string; reason?: string } };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("flow_not_waiting");
  });

  it("returns flow_state_missing_handles when stateJson lacks thread/workflow/url", async () => {
    const flowRecord = makeFakeFlowRecord({
      flowId: "flow-1",
      status: "waiting",
      revision: 2,
      stateJson: { some_other_key: "x" }, // missing required fields
    });
    const { api, tools } = makeMockApi({ flowRecord });
    entry.register(api as never);

    const result = (await tools["langgraph_resume"]!.execute("tc", {
      payload: "approve",
    })) as { details?: { status?: string; reason?: string } };
    expect(result.details?.status).toBe("error");
    expect(result.details?.reason).toBe("flow_state_missing_handles");
  });

  it("returns error when resume fetch fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("stream error"))) as never;
    try {
      const flowRecord = makeFakeFlowRecord({
        flowId: "flow-resume-1",
        status: "waiting",
        revision: 3,
        stateJson: {
          langgraph_thread_id: "th-1",
          workflow: "fleet",
          langgraph_base_url: "http://lg.test:2024",
          decision_only: true,
        },
      });
      const { api, tools } = makeMockApi({ flowRecord });
      entry.register(api as never);

      const result = (await tools["langgraph_resume"]!.execute("tc", {
        payload: "approve",
      })) as { details?: { status?: string; reason?: string } };
      expect(result.details?.status).toBe("error");
      expect(result.details?.reason).toBe("resume_failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("langgraph_resume — success path", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns resumed with flow_id, thread_id, run_id on success", async () => {
    globalThis.fetch = makeDispatchFetch({ runId: "resume-run-1" });

    const flowRecord = makeFakeFlowRecord({
      flowId: "flow-resume-ok",
      status: "waiting",
      revision: 5,
      stateJson: {
        langgraph_thread_id: "thread-resume",
        workflow: "fleet",
        langgraph_base_url: "http://lg.test:2024",
        decision_only: true,
      },
    });
    const { api, tools } = makeMockApi({ flowRecord });
    entry.register(api as never);

    const result = (await tools["langgraph_resume"]!.execute("tc", {
      payload: "approve",
    })) as {
      details?: {
        status?: string;
        flow_id?: string;
        langgraph_thread_id?: string;
        resume_run_id?: string;
      };
    };
    expect(result.details?.status).toBe("resumed");
    expect(result.details?.langgraph_thread_id).toBe("thread-resume");
    expect(result.details?.resume_run_id).toBe("resume-run-1");
  });

  it("returns resumed with specific flow_id when provided", async () => {
    globalThis.fetch = makeDispatchFetch({ runId: "resume-run-2" });

    const flowRecord = makeFakeFlowRecord({
      flowId: "flow-specific",
      status: "waiting",
      revision: 2,
      stateJson: {
        langgraph_thread_id: "th-specific",
        workflow: "fleet",
        langgraph_base_url: "http://lg.test:2024",
      },
    });
    const { api, tools } = makeMockApi({ flowRecord });
    entry.register(api as never);

    const result = (await tools["langgraph_resume"]!.execute("tc", {
      payload: { decision: "approve", feedback: "looks good" },
      flow_id: "flow-specific",
    })) as { details?: { status?: string; resume_run_id?: string } };
    expect(result.details?.status).toBe("resumed");
    expect(result.details?.resume_run_id).toBe("resume-run-2");
  });

  it("normalizes string payload 'approve' to structured object", async () => {
    // We can't easily assert the exact body sent to LangGraph, but we can
    // verify the tool succeeds with a string payload (normalizeResumePayload is exercised).
    globalThis.fetch = makeDispatchFetch();

    const flowRecord = makeFakeFlowRecord({
      flowId: "flow-norm",
      status: "waiting",
      revision: 1,
      stateJson: {
        langgraph_thread_id: "th-norm",
        workflow: "fleet",
        langgraph_base_url: "http://lg.test:2024",
      },
    });
    const { api, tools } = makeMockApi({ flowRecord });
    entry.register(api as never);

    const result = (await tools["langgraph_resume"]!.execute("tc", {
      payload: "block_revise: please fix the typos",
    })) as { details?: { status?: string } };
    expect(result.details?.status).toBe("resumed");
  });
});

// ---------------------------------------------------------------------------
// normalizeResumePayload (exported for direct unit testing)
// ---------------------------------------------------------------------------

import { normalizeResumePayload } from "./index.js";

describe("normalizeResumePayload", () => {
  it("passes non-string payloads through unchanged", () => {
    expect(normalizeResumePayload({ decision: "approve" })).toEqual({ decision: "approve" });
    expect(normalizeResumePayload(42)).toBe(42);
    expect(normalizeResumePayload(null)).toBeNull();
  });

  it("maps 'approve' variants to {decision:'approve', feedback:''}", () => {
    for (const word of ["approve", "approved", "yes", "ok", "lgtm"]) {
      const result = normalizeResumePayload(word) as { decision?: string; feedback?: string };
      expect(result.decision).toBe("approve");
      expect(result.feedback).toBe("");
    }
  });

  it("maps 'block' variants to {decision:'block_revise', feedback:''}", () => {
    for (const word of ["block", "block_revise", "revise", "no"]) {
      const result = normalizeResumePayload(word) as { decision?: string };
      expect(result.decision).toBe("block_revise");
    }
  });

  it("maps 'abort' variants to {decision:'block_abort'}", () => {
    for (const word of ["block_abort", "abort", "stop", "end", "cancel"]) {
      const result = normalizeResumePayload(word) as { decision?: string };
      expect(result.decision).toBe("block_abort");
    }
  });

  it("maps 'extend' variants to {decision:'extend'}", () => {
    for (const word of ["extend", "extend_cap", "continue"]) {
      const result = normalizeResumePayload(word) as { decision?: string };
      expect(result.decision).toBe("extend");
    }
  });

  it("extracts feedback from 'block_revise: please fix typos'", () => {
    const result = normalizeResumePayload("block_revise: please fix typos") as {
      decision?: string;
      feedback?: string;
    };
    expect(result.decision).toBe("block_revise");
    expect(result.feedback).toBe("please fix typos");
  });

  it("passes through unrecognized strings unchanged", () => {
    expect(normalizeResumePayload("my custom response")).toBe("my custom response");
    expect(normalizeResumePayload("")).toBe("");
    expect(normalizeResumePayload("   ")).toBe("   ");
  });

  it("is case-insensitive", () => {
    const result = normalizeResumePayload("APPROVE") as { decision?: string };
    expect(result.decision).toBe("approve");
  });
});

// ---------------------------------------------------------------------------
// langgraphApiKey integration — X-Api-Key header presence/absence
// ---------------------------------------------------------------------------

describe("langgraphApiKey — X-Api-Key header integration", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Build a fetch mock that captures all request headers and behaves like
   * a normal LangGraph server (thread + SSE stream with metadata frame).
   */
  function makeHeaderCapturingFetch(threadId = "th-x", runId = "run-x") {
    const capturedHeaders: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      capturedHeaders.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
      if (url.includes("/threads") && !url.includes("/runs")) {
        return new Response(JSON.stringify({ thread_id: threadId }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/runs/stream")) {
        const frame = `event: metadata\r\ndata: ${JSON.stringify({ run_id: runId })}\r\n\r\n`;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(frame));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    return { fetchImpl, capturedHeaders };
  }

  it("sends x-api-key on all outbound calls when langgraphApiKey is configured", async () => {
    const { fetchImpl, capturedHeaders } = makeHeaderCapturingFetch();
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const { api, tools } = makeMockApi({
      pluginConfig: {
        langgraphBaseUrl: "http://lg.test:2024",
        langgraphApiKey: "integration-test-key",
      },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_dispatch"]!.execute("tc", {
      workflow: "fleet",
      input: { ticket_id: "T-1" },
    })) as { details?: { status?: string } };

    expect(result.details?.status).toBe("accepted");
    // Every outbound call (createThread + stream) must have x-api-key
    expect(capturedHeaders.length).toBeGreaterThanOrEqual(2);
    for (const { headers } of capturedHeaders) {
      expect(headers["x-api-key"]).toBe("integration-test-key");
    }
  });

  it("does NOT send x-api-key when langgraphApiKey is not configured", async () => {
    const { fetchImpl, capturedHeaders } = makeHeaderCapturingFetch();
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const { api, tools } = makeMockApi({
      pluginConfig: {
        langgraphBaseUrl: "http://lg.test:2024",
        // no langgraphApiKey
      },
    });
    entry.register(api as never);

    const result = (await tools["langgraph_dispatch"]!.execute("tc", {
      workflow: "fleet",
      input: { ticket_id: "T-2" },
    })) as { details?: { status?: string } };

    expect(result.details?.status).toBe("accepted");
    expect(capturedHeaders.length).toBeGreaterThanOrEqual(1);
    for (const { headers } of capturedHeaders) {
      expect(headers).not.toHaveProperty("x-api-key");
    }
  });
});

// ---------------------------------------------------------------------------
// langgraphApiKey — sentinel no-leak test
// ---------------------------------------------------------------------------

describe("langgraphApiKey — sentinel no-leak test", () => {
  const SENTINEL = "SENTINEL_API_KEY_DO_NOT_LEAK";
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("SENTINEL never appears in logger calls or tool result", async () => {
    globalThis.fetch = makeDispatchFetch({ threadId: "th-sentinel", runId: "run-sentinel" });

    const { api, tools, logger } = makeMockApi({
      pluginConfig: {
        langgraphBaseUrl: "http://lg.test:2024",
        langgraphApiKey: SENTINEL,
      },
    });
    entry.register(api as never);

    const result = await tools["langgraph_dispatch"]!.execute("tc", {
      workflow: "fleet",
      input: { ticket_id: "T-sentinel" },
    });

    // The tool result must not contain the sentinel
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain(SENTINEL);

    // No logger call must contain the sentinel
    for (const { msg } of logger.messages) {
      expect(msg).not.toContain(SENTINEL);
    }
  });
});

// ---------------------------------------------------------------------------
// langgraph_resume — concurrent-call deduplication (#9)
// ---------------------------------------------------------------------------

describe("langgraph_resume — concurrent-call deduplication (#9)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Build a fetch mock that returns a valid SSE stream for /runs/stream calls
   * and exposes the underlying vi.fn() for call-count assertions.
   */
  function makeCountingFetch(runId = "run-concurrent-1") {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/threads") && !url.includes("/runs")) {
        return new Response(JSON.stringify({ thread_id: "th-concurrent" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/runs/stream")) {
        const frame = `event: metadata\r\ndata: ${JSON.stringify({ run_id: runId, attempt: 1 })}\r\n\r\n`;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(frame));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    return fetchImpl as unknown as typeof fetch & { mock: { calls: unknown[][] } };
  }

  it("concurrent resumes on same flow_id: one succeeds, one returns resume_already_in_progress, exactly one stream opened", async () => {
    const fetchImpl = makeCountingFetch("run-concurrent-1");
    globalThis.fetch = fetchImpl;

    const flowRecord = makeFakeFlowRecord({
      flowId: "flow-concurrent",
      status: "waiting",
      revision: 1,
      stateJson: {
        langgraph_thread_id: "th-concurrent",
        workflow: "fleet",
        langgraph_base_url: "http://lg.test:2024",
      },
    });
    const { api, tools } = makeMockApi({ flowRecord });
    entry.register(api as never);

    // Fire both calls without awaiting between them. p1 synchronously reaches
    // resumeInProgress.add(flowId) before hitting the first await, so p2's
    // resumeInProgress.has(flowId) check fires in the same microtask batch
    // and finds the lock held.
    const p1 = tools["langgraph_resume"]!.execute("tc1", {
      payload: "approve",
      flow_id: "flow-concurrent",
    });
    const p2 = tools["langgraph_resume"]!.execute("tc2", {
      payload: "approve",
      flow_id: "flow-concurrent",
    });
    const [r1, r2] = (await Promise.all([p1, p2])) as Array<{
      details?: { status?: string; reason?: string; flow_id?: string };
    }>;

    const statuses = [r1.details?.status, r2.details?.status];
    const reasons = [r1.details?.reason, r2.details?.reason];

    // Exactly one call succeeds
    expect(statuses).toContain("resumed");
    // Exactly one call is blocked
    expect(reasons).toContain("resume_already_in_progress");

    // The blocked call must carry the flow_id
    const blocked = [r1, r2].find((r) => r.details?.reason === "resume_already_in_progress")!;
    expect(blocked.details?.flow_id).toBe("flow-concurrent");

    // Exactly ONE stream was opened (no duplicate SSE subscriber)
    const streamCalls = (fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls.filter(
      ([url]) => typeof url === "string" && url.includes("/runs/stream"),
    );
    expect(streamCalls).toHaveLength(1);
  });

  it("sequential resumes on same flow_id: second call returns flow_not_waiting (lock released after first)", async () => {
    globalThis.fetch = makeCountingFetch("run-sequential-1");

    const waitingRecord = makeFakeFlowRecord({
      flowId: "flow-seq",
      status: "waiting",
      revision: 1,
      stateJson: {
        langgraph_thread_id: "th-seq",
        workflow: "fleet",
        langgraph_base_url: "http://lg.test:2024",
      },
    });
    const runningRecord = makeFakeFlowRecord({
      flowId: "flow-seq",
      status: "running",
      revision: 2,
      stateJson: {
        langgraph_thread_id: "th-seq",
        workflow: "fleet",
        langgraph_base_url: "http://lg.test:2024",
      },
    });
    const { api, tools, flowsBinding } = makeMockApi({ flowRecord: waitingRecord });
    // First findLatest() returns waiting; second returns running (post-resume)
    flowsBinding.findLatest.mockReturnValueOnce(waitingRecord).mockReturnValueOnce(runningRecord);
    flowsBinding.get.mockReturnValue(waitingRecord);
    entry.register(api as never);

    // First resume — should succeed
    const r1 = (await tools["langgraph_resume"]!.execute("tc1", { payload: "approve" })) as {
      details?: { status?: string; reason?: string };
    };
    expect(r1.details?.status).toBe("resumed");

    // Second resume — flow is now running; must return flow_not_waiting, not resume_already_in_progress
    const r2 = (await tools["langgraph_resume"]!.execute("tc2", { payload: "approve" })) as {
      details?: { status?: string; reason?: string };
    };
    expect(r2.details?.status).toBe("error");
    expect(r2.details?.reason).toBe("flow_not_waiting");
    // Lock is gone — reason is flow status, not concurrency guard
    expect(r2.details?.reason).not.toBe("resume_already_in_progress");
  });

  it("concurrent resumes on DIFFERENT flow_ids both succeed", async () => {
    globalThis.fetch = makeCountingFetch("run-multi-1");

    const flowA = makeFakeFlowRecord({
      flowId: "flow-A",
      status: "waiting",
      revision: 1,
      stateJson: {
        langgraph_thread_id: "th-A",
        workflow: "fleet",
        langgraph_base_url: "http://lg.test:2024",
      },
    });
    const flowB = makeFakeFlowRecord({
      flowId: "flow-B",
      status: "waiting",
      revision: 1,
      stateJson: {
        langgraph_thread_id: "th-B",
        workflow: "fleet",
        langgraph_base_url: "http://lg.test:2024",
      },
    });
    const { api, tools, flowsBinding } = makeMockApi({ flowRecord: flowA });
    // Dispatch to different flows by flow_id: get() returns the correct record per id
    flowsBinding.get.mockImplementation((id: string) =>
      id === "flow-A" ? flowA : id === "flow-B" ? flowB : undefined,
    );
    entry.register(api as never);

    // Both calls start without awaiting between them
    const p1 = tools["langgraph_resume"]!.execute("tc1", {
      payload: "approve",
      flow_id: "flow-A",
    });
    const p2 = tools["langgraph_resume"]!.execute("tc2", {
      payload: "approve",
      flow_id: "flow-B",
    });
    const [r1, r2] = (await Promise.all([p1, p2])) as Array<{
      details?: { status?: string; reason?: string };
    }>;

    // Both must succeed — no cross-flow lock contention
    expect(r1.details?.status).toBe("resumed");
    expect(r2.details?.status).toBe("resumed");
  });

  it("lock released on inner error: second sequential call does not get resume_already_in_progress", async () => {
    // First call: fetch rejects — dispatchAndStream throws → runIdPromise rejects
    // → outer catch returns resume_failed → finally clears the lock.
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("network error"))) as never;

    const flowRecord = makeFakeFlowRecord({
      flowId: "flow-lock-release",
      status: "waiting",
      revision: 1,
      stateJson: {
        langgraph_thread_id: "th-lr",
        workflow: "fleet",
        langgraph_base_url: "http://lg.test:2024",
      },
    });
    const { api, tools } = makeMockApi({ flowRecord });
    entry.register(api as never);

    // First call must fail
    const r1 = (await tools["langgraph_resume"]!.execute("tc1", {
      payload: "approve",
      flow_id: "flow-lock-release",
    })) as { details?: { status?: string; reason?: string } };
    expect(r1.details?.status).toBe("error");
    expect(r1.details?.reason).toBe("resume_failed");

    // Second sequential call after the first fully resolved: must NOT see the concurrency guard.
    // It will hit resume_failed again (same rejecting fetch) but NOT resume_already_in_progress.
    const r2 = (await tools["langgraph_resume"]!.execute("tc2", {
      payload: "approve",
      flow_id: "flow-lock-release",
    })) as { details?: { status?: string; reason?: string } };
    expect(r2.details?.reason).not.toBe("resume_already_in_progress");
    // Confirm it's actually trying again (resume_failed from the network, not the lock)
    expect(r2.details?.reason).toBe("resume_failed");
  });
});
