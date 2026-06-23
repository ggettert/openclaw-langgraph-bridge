import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import entry from "./index.js";
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
