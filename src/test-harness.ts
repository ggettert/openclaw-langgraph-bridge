/**
 * Shared test harness for openclaw-langgraph-bridge unit tests.
 *
 * Exports fixture builders that capture calls for assertion. Designed to
 * replace duplicated inline mocks across the 10 test files. Only fixture
 * builders live here — no real test logic.
 *
 * Usage:
 *   import { makeMockApi, makeFakeFlowsBinding, makeFakeDeps } from "./test-harness.js";
 */

import { vi } from "vitest";
import type { WebhookHandlerDeps } from "./webhook-handler.js";
import type { WakeAgentParams } from "./wake-agent.js";

// ---------------------------------------------------------------------------
// Flow binding mock
// ---------------------------------------------------------------------------

export type FakeFlowRecord = {
  flowId: string;
  revision: number;
  status?: string;
  owner_key?: string;
  stateJson?: Record<string, unknown> | string | null;
  waitJson?: Record<string, unknown> | string | null;
};

/** Build a fake managed flow record with sensible defaults. */
export function makeFakeFlowRecord(overrides?: Partial<FakeFlowRecord>): FakeFlowRecord {
  return {
    flowId: "flow-test-1",
    revision: 1,
    status: "running",
    owner_key: "agent:main:dm:user",
    stateJson: { decision_only: false },
    waitJson: null,
    ...overrides,
  };
}

export type FakeFlowsBinding = {
  createManaged: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  setWaiting: ReturnType<typeof vi.fn>;
  runTask: ReturnType<typeof vi.fn>;
  findLatest: ReturnType<typeof vi.fn>;
  getTaskSummary: ReturnType<typeof vi.fn>;
  /** Convenience: last flow passed to createManaged() */
  createdFlows: FakeFlowRecord[];
  /** Convenience: arguments passed to finish() */
  finishedFlows: unknown[];
};

/**
 * Build a fake flow binding that captures all method calls.
 * `seed` is the flow record returned by get() and findLatest().
 */
export function makeFakeFlowsBinding(seed?: FakeFlowRecord): FakeFlowsBinding {
  const record = seed ?? makeFakeFlowRecord();
  const createdFlows: FakeFlowRecord[] = [];
  const finishedFlows: unknown[] = [];

  return {
    createManaged: vi.fn((args: unknown) => {
      const flow = { ...record, ...(args as object) };
      createdFlows.push(flow as FakeFlowRecord);
      return record;
    }),
    resume: vi.fn(),
    get: vi.fn((_flowId: string) => record as Record<string, unknown>),
    finish: vi.fn((args: unknown) => {
      finishedFlows.push(args);
    }),
    setWaiting: vi.fn(),
    runTask: vi.fn(),
    findLatest: vi.fn(() => record),
    getTaskSummary: vi.fn(() => null),
    createdFlows,
    finishedFlows,
  };
}

// ---------------------------------------------------------------------------
// Wake / logger / stream mocks
// ---------------------------------------------------------------------------

export type WakeCall = { params: WakeAgentParams; deps?: unknown };

/** Build a fake wake-agent function that captures invocations. */
export function makeFakeWake(): {
  wake: (params: WakeAgentParams, deps?: unknown) => void;
  calls: WakeCall[];
} {
  const calls: WakeCall[] = [];
  const wake = vi.fn((params: WakeAgentParams, deps?: unknown) => {
    calls.push({ params, deps });
  });
  return { wake, calls };
}

export type LogMessage = { level: "info" | "warn" | "error"; msg: string };

/** Build a fake logger that captures messages for assertion. */
export function makeFakeLogger(): {
  logger: NonNullable<WebhookHandlerDeps["logger"]>;
  messages: LogMessage[];
} {
  const messages: LogMessage[] = [];
  const logger = {
    info: vi.fn((msg: string) => messages.push({ level: "info", msg })),
    warn: vi.fn((msg: string) => messages.push({ level: "warn", msg })),
    error: vi.fn((msg: string) => messages.push({ level: "error", msg })),
  };
  return { logger, messages };
}

// ---------------------------------------------------------------------------
// WebhookHandlerDeps builder
// ---------------------------------------------------------------------------

/**
 * Build a minimal WebhookHandlerDeps for processEvent tests.
 * Pass `flowRecord` to control what get() returns.
 * The default flow has decision_only=false so milestone wake tests work.
 */
export function makeFakeDeps(options?: {
  flowRecord?: Partial<FakeFlowRecord>;
  expectedToken?: string;
  agentId?: string;
  summaryMaxChars?: number;
  decisionOnly?: boolean;
}): {
  deps: WebhookHandlerDeps;
  calls: {
    runTask: ReturnType<typeof vi.fn>;
    setWaiting: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    wake: ReturnType<typeof vi.fn>;
  };
} {
  const decisionOnly = options?.decisionOnly ?? false;
  const record = makeFakeFlowRecord({
    owner_key: "agent:main:dm:user",
    revision: 1,
    stateJson: { decision_only: decisionOnly },
    ...options?.flowRecord,
  });

  const calls = {
    runTask: vi.fn(),
    setWaiting: vi.fn(),
    finish: vi.fn(),
    get: vi.fn((_flowId: string) => ({
      owner_key: record.owner_key,
      revision: record.revision,
      status: record.status,
      stateJson: record.stateJson,
    })),
    wake: vi.fn(),
  };

  const deps: WebhookHandlerDeps = {
    expectedToken: options?.expectedToken ?? "secret",
    pluginId: "openclaw-langgraph-bridge",
    agentId: options?.agentId ?? "main",
    summaryMaxChars: options?.summaryMaxChars,
    runtime: {
      tasks: {
        managedFlows: {
          bindSession: () => ({
            get: calls.get,
            runTask: calls.runTask,
            setWaiting: calls.setWaiting,
            finish: calls.finish,
          }),
        },
      },
    },
    wake: calls.wake,
    // Synchronous enqueueWake so tests can assert wake calls without async queue drain.
    enqueueWake: (_key: string, run: () => Promise<void>) => {
      void run();
    },
  };

  return { deps, calls };
}

// ---------------------------------------------------------------------------
// Mock API (for index.ts register() tests)
// ---------------------------------------------------------------------------

export type ToolExecuteFn = (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;

export type CapturedTool = {
  name: string;
  execute: ToolExecuteFn;
};

export type MockApiOptions = {
  pluginConfig?: Record<string, unknown>;
  sessionKey?: string;
  flowRecord?: FakeFlowRecord;
};

/**
 * Build a mock plugin API that captures registered tools by name.
 * Call `entry.register(api)` with this, then use `api.tools["tool_name"]`
 * to invoke execute() directly.
 */
export function makeMockApi(options?: MockApiOptions): {
  api: Record<string, unknown>;
  tools: Record<string, CapturedTool>;
  flowsBinding: FakeFlowsBinding;
  logger: ReturnType<typeof makeFakeLogger>;
} {
  const sessionKey = options?.sessionKey ?? "agent:main:dm:user";
  const flowRecord = options?.flowRecord ?? makeFakeFlowRecord();
  const flowsBinding = makeFakeFlowsBinding(flowRecord);
  const loggerResult = makeFakeLogger();
  const { logger } = loggerResult;

  const tools: Record<string, CapturedTool> = {};

  const api = {
    logger: logger,
    pluginConfig: options?.pluginConfig ?? {
      langgraphBaseUrl: "http://lg.test:2024",
      callbackToken: "tok-abc",
      agentId: "main",
    },
    runtime: {
      tasks: {
        managedFlows: {
          fromToolContext: vi.fn(() => flowsBinding),
          bindSession: vi.fn(() => flowsBinding),
        },
      },
    },
    registerTool: vi.fn(
      (factory: (ctx: unknown) => { name: string; execute: unknown; [k: string]: unknown }) => {
        const toolDef = factory({ sessionKey, deliveryContext: {} });
        tools[toolDef.name] = {
          name: toolDef.name,
          execute: toolDef.execute as ToolExecuteFn,
        };
      },
    ),
    registerHttpRoute: vi.fn(),
  };

  return { api, tools, flowsBinding, logger: loggerResult };
}

// ---------------------------------------------------------------------------
// Fake LangGraph fetch capture
// ---------------------------------------------------------------------------

export type FetchCapture = { url: string; body: unknown };

/**
 * Build a fetch mock that captures calls and returns a configured response.
 * Default: returns HTTP 200 with `responseBody` as JSON.
 */
export function makeFakeFetch(options?: {
  status?: number;
  responseBody?: unknown;
  rejectWith?: Error;
}): { fetchImpl: typeof fetch; captures: FetchCapture[] } {
  const captures: FetchCapture[] = [];

  if (options?.rejectWith) {
    const err = options.rejectWith;
    const fetchImpl = vi.fn(() => Promise.reject(err)) as unknown as typeof fetch;
    return { fetchImpl, captures };
  }

  const responseBody = options?.responseBody ?? {};
  const status = options?.status ?? 200;

  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    captures.push({
      url: urlStr,
      body: init?.body ? JSON.parse(init.body as string) : null,
    });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, captures };
}
