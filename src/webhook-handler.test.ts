import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetInvalidMilestoneModelFlowsForTest,
  processEvent,
  type WebhookHandlerDeps,
} from "./webhook-handler.js";
import { makeFakeDeps } from "./test-harness.js";
import type { WakeAgentParams } from "./wake-agent.js";

// Alias to preserve existing test call sites unchanged.
const makeDeps = () => makeFakeDeps({ decisionOnly: false });

describe("processEvent — status", () => {
  it("calls runTask, does NOT wake, emits NO system event", () => {
    const { deps, calls } = makeDeps();
    const result = processEvent({
      body: {
        kind: "status",
        flow_id: "f1",
        seq: 3,
        title: "node:coder",
        summary: "started",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(result).toEqual({ status: "ok", action: "flow-update-only" });
    expect(calls.runTask).toHaveBeenCalledOnce();
    expect(calls.wake).not.toHaveBeenCalled();
    expect(calls.setWaiting).not.toHaveBeenCalled();
    expect(calls.finish).not.toHaveBeenCalled();
  });
});

describe("processEvent — milestone", () => {
  it("calls runTask + wakes with agentId + sessionKey + formatted message", () => {
    const { deps, calls } = makeDeps();
    processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.runTask).toHaveBeenCalledOnce();
    expect(calls.wake).toHaveBeenCalledOnce();
    const wakeArgs = calls.wake.mock.calls[0]![0];
    expect(wakeArgs.agentId).toBe("main");
    expect(wakeArgs.sessionKey).toBe("agent:main:dm:user");
    expect(wakeArgs.message).toMatch(/\[langgraph:milestone\] build:ok/);
  });
});

describe("processEvent — decision", () => {
  it("does NOT mutate flow but wakes with decision message", () => {
    const { deps, calls } = makeDeps();
    processEvent({
      body: {
        kind: "decision",
        flow_id: "f1",
        title: "needs:input",
        summary: "which target env?",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.runTask).not.toHaveBeenCalled();
    expect(calls.setWaiting).not.toHaveBeenCalled();
    expect(calls.finish).not.toHaveBeenCalled();
    expect(calls.wake).toHaveBeenCalledOnce();
    const wakeArgs = calls.wake.mock.calls[0]![0];
    expect(wakeArgs.message).toMatch(/\[langgraph:decision\] needs:input/);
    expect(wakeArgs.message).toMatch(/which target env\?/);
  });
});

describe("processEvent — hitl", () => {
  it("calls setWaiting with interrupt_id + prompt, then wakes", () => {
    const { deps, calls } = makeDeps();
    processEvent({
      body: {
        kind: "hitl",
        flow_id: "f1",
        title: "approval-gate",
        summary: "approve deploy?",
        interrupt_id: "i-99",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 7,
      deps,
    });
    expect(calls.setWaiting).toHaveBeenCalledOnce();
    const setWaitingArgs = calls.setWaiting.mock.calls[0]![0] as {
      flowId: string;
      expectedRevision: number;
      waitJson: Record<string, unknown>;
    };
    expect(setWaitingArgs.flowId).toBe("f1");
    // Revision is re-read from flows.get() (mocked to 1), not the hint.
    expect(setWaitingArgs.expectedRevision).toBe(1);
    expect(setWaitingArgs.waitJson).toMatchObject({
      kind: "langgraph_interrupt",
      interrupt_id: "i-99",
      prompt: "approve deploy?",
    });
    expect(calls.wake).toHaveBeenCalledOnce();
    const wakeArgs = calls.wake.mock.calls[0]![0];
    expect(wakeArgs.message).toMatch(/\[langgraph:hitl\] approval-gate/);
  });
});

describe("processEvent — terminal", () => {
  it("calls finish + wakes", () => {
    const { deps, calls } = makeDeps();
    processEvent({
      body: {
        kind: "terminal",
        flow_id: "f1",
        title: "ok",
        summary: "deploy succeeded",
        data: { exit_code: 0 },
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 3,
      deps,
    });
    expect(calls.finish).toHaveBeenCalledOnce();
    const finishArgs = calls.finish.mock.calls[0]![0] as {
      flowId: string;
      expectedRevision: number;
      stateJson: Record<string, unknown>;
    };
    expect(finishArgs.flowId).toBe("f1");
    // Revision is re-read from flows.get() (mocked to 1), not the hint.
    expect(finishArgs.expectedRevision).toBe(1);
    expect(finishArgs.stateJson).toMatchObject({
      terminal_title: "ok",
      terminal_summary: "deploy succeeded",
      data: { exit_code: 0 },
    });
    expect(calls.wake).toHaveBeenCalledOnce();
    const wakeArgs = calls.wake.mock.calls[0]![0];
    expect(wakeArgs.message).toMatch(/\[langgraph:terminal\] ok/);
  });
});

describe("processEvent — text formatting", () => {
  it("truncates summary to summaryMaxChars (default 4000) in wake message", () => {
    const { deps, calls } = makeDeps();
    // 6000 'x's is above the 4000 default cap.
    processEvent({
      body: {
        kind: "decision",
        flow_id: "f1",
        title: "long-event",
        summary: "x".repeat(6000),
      },
      sessionKey: "s",
      flowRevision: 1,
      deps,
    });
    const wakeArgs = calls.wake.mock.calls[0]![0];
    expect(wakeArgs.message).toMatch(/\[langgraph:decision\] long-event\n/);
    // No spaces in the summary so the cut lands at exactly the cap.
    const summaryLine = wakeArgs.message.split("\n")[1]!;
    expect(summaryLine.endsWith(" \u2026[truncated]")).toBe(true);
    expect(summaryLine.length).toBe(4000 + 13); // 'x'.repeat(4000) + ' …[truncated]'
  });

  it("respects a custom summaryMaxChars from deps", () => {
    const { deps, calls } = makeDeps();
    deps.summaryMaxChars = 100;
    processEvent({
      body: {
        kind: "decision",
        flow_id: "f1",
        title: "long-event",
        summary: "x".repeat(500),
      },
      sessionKey: "s",
      flowRevision: 1,
      deps,
    });
    const wakeArgs = calls.wake.mock.calls[0]![0];
    const summaryLine = wakeArgs.message.split("\n")[1]!;
    expect(summaryLine.endsWith(" \u2026[truncated]")).toBe(true);
    expect(summaryLine.length).toBe(100 + 13);
  });

  it("does NOT truncate summary that fits within the cap", () => {
    const { deps, calls } = makeDeps();
    const shortSummary = "a short summary";
    processEvent({
      body: {
        kind: "milestone",
        flow_id: "f1",
        title: "x",
        summary: shortSummary,
      },
      sessionKey: "s",
      flowRevision: 1,
      deps,
    });
    const wakeArgs = calls.wake.mock.calls[0]![0];
    expect(wakeArgs.message).toContain(shortSummary);
    expect(wakeArgs.message).not.toContain("\u2026[truncated]");
  });
});

describe("processEvent — FIFO wake ordering (real queue)", () => {
  it("3 milestone events arrive in emission order when real enqueueWake is used", async () => {
    // This test does NOT inject enqueueWake, so the real per-sessionKey
    // FIFO queue from wake-queue.ts is exercised end-to-end.
    const sessionKey = `agent:main:slack:dm:order-test-${Math.random()}`;
    const wakeOrder: string[] = [];

    // Deferred promises give us explicit control over when each
    // "subprocess" resolves so we can verify ordering under back-pressure.
    type Deferred = { resolve: () => void; promise: Promise<void> };
    const makeDeferredWake = (): Deferred => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { resolve, promise };
    };

    const d = [makeDeferredWake(), makeDeferredWake(), makeDeferredWake()];
    let callIdx = 0;

    const wake = vi.fn(async (params: WakeAgentParams) => {
      const idx = callIdx++;
      // Extract the event title from the formatted message (format: "[langgraph:milestone] <title>")
      const titleMatch = params.message.match(/\[langgraph:milestone\] (\S+)/);
      wakeOrder.push(titleMatch?.[1] ?? `idx-${idx}`);
      await d[idx]!.promise;
    });

    const get = vi.fn<(flowId: string) => Record<string, unknown> | undefined>(() => ({
      owner_key: sessionKey,
      revision: 1,
      stateJson: { decision_only: false },
    }));
    const deps: WebhookHandlerDeps = {
      expectedToken: "secret",
      pluginId: "openclaw-langgraph-bridge",
      agentId: "main",
      runtime: {
        tasks: {
          managedFlows: {
            bindSession: () => ({
              get,
              runTask: vi.fn(),
              setWaiting: vi.fn(),
              finish: vi.fn(),
            }),
          },
        },
      },
      wake,
      // No enqueueWake override — real queue from wake-queue.ts
    };

    const mkEvent = (title: string) => ({
      body: { kind: "milestone" as const, flow_id: "f-ord", title, summary: "" },
      sessionKey,
      flowRevision: 1,
      deps,
    });

    // Emit 3 events in quick succession. Drain starts async; all 3 land
    // in the queue before the first subprocess exits.
    processEvent(mkEvent("first"));
    processEvent(mkEvent("second"));
    processEvent(mkEvent("third"));

    // Let the drain loop start and call the first wake.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(wakeOrder).toEqual(["first"]); // only first has started

    d[0]!.resolve(); // finish first
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(wakeOrder).toEqual(["first", "second"]);

    d[1]!.resolve(); // finish second
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(wakeOrder).toEqual(["first", "second", "third"]);

    d[2]!.resolve(); // finish third
    await new Promise<void>((r) => setTimeout(r, 0));
  });
});

describe("processEvent — reply hint from sessionKey", () => {
  it("prepends a Slack-thread reply hint when sessionKey carries :slack:channel:<ch>:thread:<ts>", () => {
    const { deps, calls } = makeDeps();
    processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "coder:done" },
      sessionKey: "agent:main:slack:channel:c0ba88ychfz:thread:1781634334.310769",
      flowRevision: 1,
      deps,
    });
    const wakeArgs = calls.wake.mock.calls[0]![0];
    expect(wakeArgs.message).toMatch(/^\[reply-hint\]/);
    expect(wakeArgs.message).toContain('threadId="1781634334.310769"');
    expect(wakeArgs.message).toContain("channel=c0ba88ychfz");
    expect(wakeArgs.message).toMatch(/\[langgraph:milestone\] coder:done/);
  });

  it("omits the hint for plain DM session keys", () => {
    const { deps, calls } = makeDeps();
    processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "x" },
      sessionKey: "agent:main:slack:dm:user-abc",
      flowRevision: 1,
      deps,
    });
    const wakeArgs = calls.wake.mock.calls[0]![0];
    expect(wakeArgs.message).not.toMatch(/\[reply-hint\]/);
    expect(wakeArgs.message.startsWith("[langgraph:milestone]")).toBe(true);
  });
});

describe("processEvent — agentId plumbed from deps", () => {
  it("uses configured agentId in wake call (not hardcoded 'main')", () => {
    const { deps, calls } = makeDeps();
    deps.agentId = "kit-prod";
    processEvent({
      body: { kind: "decision", flow_id: "f1", title: "x" },
      sessionKey: "agent:kit-prod:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[0]![0].agentId).toBe("kit-prod");
  });
});

describe("processEvent — decision_only flag (#6)", () => {
  // Alias to preserve call sites unchanged.
  const makeDepsWithDecisionOnly = (decisionOnly: boolean) => makeFakeDeps({ decisionOnly });

  it("milestone + decision_only=true → updates flow state but does NOT wake", () => {
    const { deps, calls } = makeDepsWithDecisionOnly(true);
    const result = processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(result).toEqual({ status: "ok", action: "wake-light" });
    expect(calls.runTask).toHaveBeenCalledOnce(); // flow state still updated
    expect(calls.wake).not.toHaveBeenCalled(); // but no wake
  });

  it("milestone + decision_only=false → updates flow state AND wakes", () => {
    const { deps, calls } = makeDepsWithDecisionOnly(false);
    processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.runTask).toHaveBeenCalledOnce();
    expect(calls.wake).toHaveBeenCalledOnce();
    const wakeArgs = calls.wake.mock.calls[0]![0];
    expect(wakeArgs.message).toMatch(/\[langgraph:milestone\] build:ok/);
  });

  it("decision + decision_only=true → still wakes (only milestone is suppressed)", () => {
    const { deps, calls } = makeDepsWithDecisionOnly(true);
    processEvent({
      body: { kind: "decision", flow_id: "f1", title: "needs:input", summary: "approve?" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake).toHaveBeenCalledOnce();
  });

  it("hitl + decision_only=true → still wakes", () => {
    const { deps, calls } = makeDepsWithDecisionOnly(true);
    processEvent({
      body: { kind: "hitl", flow_id: "f1", title: "gate", interrupt_id: "i-1" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.setWaiting).toHaveBeenCalledOnce();
    expect(calls.wake).toHaveBeenCalledOnce();
  });

  it("terminal + decision_only=true → still wakes", () => {
    const { deps, calls } = makeDepsWithDecisionOnly(true);
    processEvent({
      body: { kind: "terminal", flow_id: "f1", title: "ok", summary: "done" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.finish).toHaveBeenCalledOnce();
    expect(calls.wake).toHaveBeenCalledOnce();
  });

  it("milestone + stateJson missing (no decision_only key) → defaults to true → no wake", () => {
    // Simulate a flow that was dispatched before decision_only was stored,
    // or any flow that has no stateJson. Should default to decision_only=true.
    const { deps, calls } = makeFakeDeps({ flowRecord: { stateJson: null } });
    processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    // Default behavior (decision_only=true): milestone does NOT wake.
    expect(calls.runTask).toHaveBeenCalledOnce();
    expect(calls.wake).not.toHaveBeenCalled();
  });

  it("defaults to decision_only=true when stateJson lacks the field (backward-compat for pre-#6 flows)", () => {
    // Simulate a flow dispatched before #6 — stateJson exists (workflow stored)
    // but the decision_only key was never written into it.
    // Milestone event arrives → no wake fires because default is true.
    const { deps, calls } = makeFakeDeps({ flowRecord: { stateJson: { workflow: "fleet" } } });
    processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    // Pre-#6 flows never stored decision_only; absence → default true → no wake.
    expect(calls.runTask).toHaveBeenCalledOnce();
    expect(calls.wake).not.toHaveBeenCalled();
  });
});

describe("processEvent — terminated-flow guard (#10, #16)", () => {
  // Alias to preserve call sites unchanged.
  const makeDepsWithFlowStatus = (flowStatus: string) =>
    makeFakeDeps({ flowRecord: { revision: 5, status: flowStatus, stateJson: null } });

  it("ignores stale `hitl` after `succeeded` — no setWaiting, no wake (#16)", () => {
    const { deps, calls } = makeDepsWithFlowStatus("succeeded");
    const result = processEvent({
      body: {
        kind: "hitl",
        flow_id: "f1",
        title: "merge_gate",
        summary: "stale interrupt",
        interrupt_id: "i-stale",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(result).toEqual({
      status: "ok",
      action: "ignored:post-terminal",
    });
    expect(calls.setWaiting).not.toHaveBeenCalled();
    expect(calls.wake).not.toHaveBeenCalled();
  });

  it("ignores stale `terminal` after `succeeded` — no finish, no wake, no 500 (#10)", () => {
    const { deps, calls } = makeDepsWithFlowStatus("succeeded");
    const result = processEvent({
      body: {
        kind: "terminal",
        flow_id: "f1",
        title: "graph:end",
        summary: "duplicate terminal",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(result).toEqual({
      status: "ok",
      action: "ignored:post-terminal",
    });
    expect(calls.finish).not.toHaveBeenCalled();
    expect(calls.wake).not.toHaveBeenCalled();
  });

  it("ignores stale `milestone` after `cancelled`", () => {
    const { deps, calls } = makeDepsWithFlowStatus("cancelled");
    processEvent({
      body: {
        kind: "milestone",
        flow_id: "f1",
        title: "node:merge",
        summary: "recap",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.runTask).not.toHaveBeenCalled();
    expect(calls.wake).not.toHaveBeenCalled();
  });

  it("treats `failed` as terminal", () => {
    const { deps, calls } = makeDepsWithFlowStatus("failed");
    processEvent({
      body: { kind: "hitl", flow_id: "f1", title: "x" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.setWaiting).not.toHaveBeenCalled();
  });

  it("treats `lost` as terminal", () => {
    const { deps, calls } = makeDepsWithFlowStatus("lost");
    processEvent({
      body: { kind: "terminal", flow_id: "f1", title: "x" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.finish).not.toHaveBeenCalled();
  });

  it("does NOT treat `blocked` as terminal — still processes (blocked can recover)", () => {
    const { deps, calls } = makeDepsWithFlowStatus("blocked");
    processEvent({
      body: { kind: "hitl", flow_id: "f1", title: "real-interrupt" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.setWaiting).toHaveBeenCalledOnce();
  });

  it("non-terminal status (`running`, `waiting`) is NOT guarded — processes normally", () => {
    const { deps: depsRunning, calls: callsRunning } = makeDepsWithFlowStatus("running");
    processEvent({
      body: { kind: "hitl", flow_id: "f1", title: "real-interrupt" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps: depsRunning,
    });
    expect(callsRunning.setWaiting).toHaveBeenCalledOnce();
    expect(callsRunning.wake).toHaveBeenCalledOnce();
  });

  it("missing status field is NOT guarded — processes normally", () => {
    // Backward compat: older flow records may not include `status` in get() return.
    // Use decision_only=false so milestone fires a wake (tests the guard, not the flag).
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: { status: undefined },
    });
    processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "x" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.runTask).toHaveBeenCalledOnce();
    expect(calls.wake).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// buildHandler — HTTP route handler tests
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildHandler } from "./webhook-handler.js";

/** Build a minimal mock IncomingMessage for testing the HTTP handler. */
function makeReq(options?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const method = options?.method ?? "POST";
  const headers = options?.headers ?? { authorization: "Bearer secret" };
  const bodyStr = options?.body ?? JSON.stringify({ kind: "status", flow_id: "f1", title: "t" });

  const emitter = new EventEmitter() as IncomingMessage;
  emitter.method = method;
  emitter.headers = headers;
  // Simulate async body read
  setImmediate(() => {
    emitter.emit("data", Buffer.from(bodyStr, "utf8"));
    emitter.emit("end");
  });
  return emitter;
}

/** Build a minimal mock ServerResponse that captures status + body. */
function makeRes(): ServerResponse & { _statusCode: number; _body: string } {
  const res = {
    _statusCode: 0,
    _body: "",
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn((body: string) => {
      res._statusCode = res.statusCode;
      res._body = body;
    }),
  } as unknown as ServerResponse & { _statusCode: number; _body: string };
  return res;
}

describe("buildHandler — HTTP route handler", () => {
  it("returns 405 for non-POST requests", async () => {
    const { deps } = makeDeps();
    const handler = buildHandler(deps);
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res._body)).toMatchObject({ error: "method_not_allowed" });
  });

  it("returns 503 when no callbackToken is configured", async () => {
    const { deps } = makeFakeDeps({ expectedToken: undefined as unknown as string });
    // Override to undefined
    deps.expectedToken = undefined;
    const handler = buildHandler(deps);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res._body)).toMatchObject({ error: "callback_token_not_configured" });
  });

  it("returns 401 for wrong Bearer token", async () => {
    const { deps } = makeDeps();
    const handler = buildHandler(deps);
    const req = makeReq({ headers: { authorization: "Bearer wrong-token" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res._body)).toMatchObject({ error: "unauthorized" });
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { deps } = makeDeps();
    const handler = buildHandler(deps);
    const req = makeReq({ headers: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 for invalid JSON", async () => {
    const { deps } = makeDeps();
    const handler = buildHandler(deps);
    const req = makeReq({ body: "not-json" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res._body)).toMatchObject({ error: "invalid_json" });
  });

  it("returns 400 for missing flow_id", async () => {
    const { deps } = makeDeps();
    const handler = buildHandler(deps);
    const req = makeReq({ body: JSON.stringify({ kind: "status" }) });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res._body)).toMatchObject({ error: "missing_flow_id" });
  });

  it("returns 400 for invalid kind", async () => {
    const { deps } = makeDeps();
    const handler = buildHandler(deps);
    const req = makeReq({ body: JSON.stringify({ kind: "bogus", flow_id: "f1" }) });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res._body)).toMatchObject({ error: "invalid_kind" });
  });

  it("returns 404 when flow not found", async () => {
    const { deps } = makeFakeDeps({ flowRecord: { flowId: "unknown" } });
    // Override get() to return undefined (flow not found)
    deps.runtime.tasks.managedFlows.bindSession = () => ({
      get: () => undefined,
      runTask: vi.fn(),
      setWaiting: vi.fn(),
      finish: vi.fn(),
    });
    const handler = buildHandler(deps);
    const req = makeReq({ body: JSON.stringify({ kind: "status", flow_id: "missing-flow" }) });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res._body)).toMatchObject({ error: "flow_not_found" });
  });

  it("returns 409 when flow has no owner_key", async () => {
    const { deps } = makeFakeDeps();
    deps.runtime.tasks.managedFlows.bindSession = () => ({
      get: () => ({ revision: 1 }), // no owner_key
      runTask: vi.fn(),
      setWaiting: vi.fn(),
      finish: vi.fn(),
    });
    const handler = buildHandler(deps);
    const req = makeReq({ body: JSON.stringify({ kind: "status", flow_id: "f1" }) });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res._body)).toMatchObject({ error: "flow_missing_owner_key" });
  });

  it("returns 200 on successful status event", async () => {
    const { deps } = makeDeps();
    const handler = buildHandler(deps);
    const req = makeReq({
      body: JSON.stringify({ kind: "status", flow_id: "f1", title: "node:coder", seq: 1 }),
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject({ status: "ok", action: "flow-update-only" });
  });

  it("returns 200 on successful milestone event", async () => {
    const { deps } = makeDeps();
    const handler = buildHandler(deps);
    const req = makeReq({
      body: JSON.stringify({ kind: "milestone", flow_id: "f1", title: "build:ok" }),
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 200 on successful terminal event", async () => {
    const { deps } = makeDeps();
    const handler = buildHandler(deps);
    const req = makeReq({
      body: JSON.stringify({
        kind: "terminal",
        flow_id: "f1",
        title: "ok",
        summary: "done",
      }),
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 500 when processEvent throws unexpectedly", async () => {
    const { deps } = makeDeps();
    // Make runTask throw so processEvent propagates the error.
    deps.runtime.tasks.managedFlows.bindSession = () => ({
      get: () => ({ owner_key: "agent:main:dm:user", revision: 1, stateJson: null }),
      runTask: () => {
        throw new Error("unexpected db error");
      },
      setWaiting: vi.fn(),
      finish: vi.fn(),
    });
    const handler = buildHandler(deps);
    const req = makeReq({
      body: JSON.stringify({ kind: "status", flow_id: "f1", title: "t" }),
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res._body)).toMatchObject({ error: "routing_failed" });
  });
});

describe("processEvent — milestone_model dispatch param (#83)", () => {
  beforeEach(() => {
    __resetInvalidMilestoneModelFlowsForTest();
  });

  it("forwards `milestone_model` to wake for milestone events when present in stateJson", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });
    processEvent({
      body: { kind: "milestone", flow_id: "f-mm-1", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake).toHaveBeenCalledOnce();
    const wakeParams = calls.wake.mock.calls[0]![0];
    expect(wakeParams.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("does NOT forward `milestone_model` to wake for decision events", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });
    processEvent({
      body: { kind: "decision", flow_id: "f-mm-2", title: "needs:input", summary: "approve?" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake).toHaveBeenCalledOnce();
    const wakeParams = calls.wake.mock.calls[0]![0];
    expect(wakeParams.model).toBeUndefined();
  });

  it("does NOT forward `milestone_model` to wake for hitl events", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });
    processEvent({
      body: { kind: "hitl", flow_id: "f-mm-3", title: "gate", interrupt_id: "i" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake).toHaveBeenCalledOnce();
    const wakeParams = calls.wake.mock.calls[0]![0];
    expect(wakeParams.model).toBeUndefined();
  });

  it("does NOT forward `milestone_model` to wake for terminal events", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });
    processEvent({
      body: { kind: "terminal", flow_id: "f-mm-4", title: "done", summary: "ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake).toHaveBeenCalledOnce();
    const wakeParams = calls.wake.mock.calls[0]![0];
    expect(wakeParams.model).toBeUndefined();
  });

  it("absent / null `milestone_model` in stateJson → no `model` on wake (back-compat)", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: { stateJson: { decision_only: false } }, // no milestone_model
    });
    processEvent({
      body: { kind: "milestone", flow_id: "f-mm-5", title: "x" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    const wakeParams = calls.wake.mock.calls[0]![0];
    expect(wakeParams.model).toBeUndefined();
  });

  it("empty / whitespace `milestone_model` is treated as unset", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: { decision_only: false, milestone_model: "   " },
      },
    });
    processEvent({
      body: { kind: "milestone", flow_id: "f-mm-6", title: "x" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    const wakeParams = calls.wake.mock.calls[0]![0];
    expect(wakeParams.model).toBeUndefined();
  });

  it("after onInvalidModel fires for a flow, subsequent milestones for SAME flow skip the override", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: { decision_only: false, milestone_model: "bad-model" },
      },
    });

    // First milestone: model should be forwarded.
    processEvent({
      body: { kind: "milestone", flow_id: "f-mm-cache", title: "a" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    const firstWake = calls.wake.mock.calls[0]!;
    expect(firstWake[0].model).toBe("bad-model");
    // Simulate wake-agent invoking onInvalidModel after the gateway rejection.
    const onInvalidModel = firstWake[1]?.onInvalidModel;
    expect(typeof onInvalidModel).toBe("function");
    onInvalidModel?.({ model: "bad-model", cliError: "is not allowed" });

    // Second milestone for the SAME flow: model should be undefined now.
    processEvent({
      body: { kind: "milestone", flow_id: "f-mm-cache", title: "b" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    const secondWake = calls.wake.mock.calls[1]!;
    expect(secondWake[0].model).toBeUndefined();
  });

  it("a DIFFERENT flow with the same bad model still pays the rejection cost once", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: { decision_only: false, milestone_model: "bad-model" },
      },
    });

    // Reject for flow A.
    processEvent({
      body: { kind: "milestone", flow_id: "flow-A", title: "a" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    calls.wake.mock.calls[0]![1]?.onInvalidModel?.({
      model: "bad-model",
      cliError: "is not allowed",
    });

    // Different flow B: still gets the override on its first attempt.
    processEvent({
      body: { kind: "milestone", flow_id: "flow-B", title: "a" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[1]![0].model).toBe("bad-model");
  });

  it("terminal event GCs the per-flow rejection cache entry", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: { decision_only: false, milestone_model: "bad-model" },
      },
    });

    // Reject for flow.
    processEvent({
      body: { kind: "milestone", flow_id: "flow-gc", title: "a" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    calls.wake.mock.calls[0]![1]?.onInvalidModel?.({
      model: "bad-model",
      cliError: "is not allowed",
    });

    // Terminal arrives for same flow.
    processEvent({
      body: { kind: "terminal", flow_id: "flow-gc", title: "done" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });

    // A new milestone for the SAME flow id after terminal would now NOT
    // be suppressed (cache was cleared by terminal). In real life flow
    // ids are unique per run, but the GC is observable here.
    processEvent({
      body: { kind: "milestone", flow_id: "flow-gc", title: "x" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    // calls[0] = first milestone, calls[1] = terminal wake, calls[2] = second milestone
    const secondMilestone = calls.wake.mock.calls.find(
      (c, idx) => idx > 0 && c[0].message.includes("[langgraph:milestone]"),
    );
    expect(secondMilestone).toBeDefined();
    expect(secondMilestone![0].model).toBe("bad-model");
  });

  it("decision_only=true suppresses milestone wakes BEFORE model is ever considered", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: true,
      flowRecord: {
        stateJson: { decision_only: true, milestone_model: "anthropic/claude-sonnet-4-6" },
      },
    });
    processEvent({
      body: { kind: "milestone", flow_id: "f-mm-suppressed", title: "x" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.runTask).toHaveBeenCalledOnce(); // flow state still updated
    expect(calls.wake).not.toHaveBeenCalled(); // no wake at all
  });
});

describe("processEvent — wakeThinking per-event-class (issue #100)", () => {
  it("milestone wake gets thinking 'off' by default (no wakeThinking config)", () => {
    const { deps, calls } = makeFakeDeps({ decisionOnly: false });
    // No deps.wakeThinking set — milestone should default to 'off'.
    processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake).toHaveBeenCalledOnce();
    expect(calls.wake.mock.calls[0]![0].thinking).toBe("off");
  });

  it("milestone thinking is overrideable via deps.wakeThinking.milestone", () => {
    const { deps, calls } = makeFakeDeps({ decisionOnly: false });
    deps.wakeThinking = { milestone: "low" };
    processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "x" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake).toHaveBeenCalledOnce();
    expect(calls.wake.mock.calls[0]![0].thinking).toBe("low");
  });

  it("decision wake has thinking undefined when deps.wakeThinking.decision is unset (inherit session)", () => {
    const { deps, calls } = makeFakeDeps({ decisionOnly: false });
    // No wakeThinking configured — decision should get undefined (inherit).
    processEvent({
      body: { kind: "decision", flow_id: "f1", title: "x", summary: "approve?" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake).toHaveBeenCalledOnce();
    expect(calls.wake.mock.calls[0]![0].thinking).toBeUndefined();
  });

  it("configured decision thinking level is passed through to wake", () => {
    const { deps, calls } = makeFakeDeps({ decisionOnly: false });
    deps.wakeThinking = { decision: "medium" };
    processEvent({
      body: { kind: "decision", flow_id: "f1", title: "x", summary: "approve?" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake).toHaveBeenCalledOnce();
    expect(calls.wake.mock.calls[0]![0].thinking).toBe("medium");
  });

  it("hitl wake has thinking undefined when deps.wakeThinking.hitl is unset", () => {
    const { deps, calls } = makeFakeDeps({ decisionOnly: false });
    processEvent({
      body: { kind: "hitl", flow_id: "f1", title: "gate", interrupt_id: "i-1" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake).toHaveBeenCalledOnce();
    expect(calls.wake.mock.calls[0]![0].thinking).toBeUndefined();
  });

  it("terminal wake has thinking undefined when deps.wakeThinking.terminal is unset", () => {
    const { deps, calls } = makeFakeDeps({ decisionOnly: false });
    processEvent({
      body: { kind: "terminal", flow_id: "f1", title: "done", summary: "ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake).toHaveBeenCalledOnce();
    expect(calls.wake.mock.calls[0]![0].thinking).toBeUndefined();
  });
});
