import { describe, expect, it, vi } from "vitest";
import { processEvent, type WebhookHandlerDeps } from "./webhook-handler.js";

type AnyArgs = unknown[];

function makeDeps() {
  const calls = {
    runTask: vi.fn<(...args: AnyArgs) => unknown>(),
    setWaiting: vi.fn<(...args: AnyArgs) => unknown>(),
    finish: vi.fn<(...args: AnyArgs) => unknown>(),
    enqueueSystemEvent: vi.fn<(text: string, opts: { sessionKey: string; contextKey?: string | null }) => boolean>(() => true),
    requestHeartbeat: vi.fn<(opts: { source: string; intent: string; reason?: string; sessionKey?: string; coalesceMs?: number }) => void>(),
    get: vi.fn<(flowId: string) => Record<string, unknown> | undefined>(() => ({ owner_key: "agent:main:dm:user", revision: 1 })),
  };
  const deps: WebhookHandlerDeps = {
    expectedToken: "secret",
    pluginId: "openclaw-langgraph-bridge",
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
      system: {
        enqueueSystemEvent: calls.enqueueSystemEvent,
        requestHeartbeat: calls.requestHeartbeat,
      },
    },
  };
  return { deps, calls };
}

describe("processEvent — status", () => {
  it("calls runTask, enqueues with noise contextKey, does NOT wake", () => {
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
    expect(calls.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect((calls.enqueueSystemEvent.mock.calls[0]![1] as { contextKey: string | null }).contextKey).toBe(
      "langgraph:f1:status",
    );
    expect(calls.requestHeartbeat).not.toHaveBeenCalled();
    expect(calls.setWaiting).not.toHaveBeenCalled();
    expect(calls.finish).not.toHaveBeenCalled();
  });
});

describe("processEvent — milestone", () => {
  it("calls runTask + enqueues + WAKES with reason langgraph-wake-light", () => {
    const { deps, calls } = makeDeps();
    processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.runTask).toHaveBeenCalledOnce();
    expect(calls.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect((calls.enqueueSystemEvent.mock.calls[0]![1] as { contextKey: string | null }).contextKey).toBeNull();
    expect(calls.requestHeartbeat).toHaveBeenCalledOnce();
    const hbLight = calls.requestHeartbeat.mock.calls[0]![0] as { reason?: string; sessionKey?: string };
    expect(hbLight.reason).toBe("langgraph-wake-light");
    expect(hbLight.sessionKey).toBe("agent:main:dm:user");
  });
});

describe("processEvent — decision", () => {
  it("does NOT mutate flow but wakes with decision reason", () => {
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
    expect(calls.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(calls.requestHeartbeat).toHaveBeenCalledOnce();
    const hbDecision = calls.requestHeartbeat.mock.calls[0]![0] as { reason?: string };
    expect(hbDecision.reason).toBe("langgraph-wake-decision");
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
    expect(setWaitingArgs.expectedRevision).toBe(7);
    expect(setWaitingArgs.waitJson).toMatchObject({
      kind: "langgraph_interrupt",
      interrupt_id: "i-99",
      prompt: "approve deploy?",
    });
    expect(calls.requestHeartbeat).toHaveBeenCalledOnce();
    const hbHitl = calls.requestHeartbeat.mock.calls[0]![0] as { reason?: string };
    expect(hbHitl.reason).toBe("langgraph-wake-hitl");
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
    expect(finishArgs.expectedRevision).toBe(3);
    expect(finishArgs.stateJson).toMatchObject({
      terminal_title: "ok",
      terminal_summary: "deploy succeeded",
      data: { exit_code: 0 },
    });
    expect(calls.requestHeartbeat).toHaveBeenCalledOnce();
    const hbTerm = calls.requestHeartbeat.mock.calls[0]![0] as { reason?: string };
    expect(hbTerm.reason).toBe("langgraph-wake-terminal");
  });
});

describe("processEvent — text formatting", () => {
  it("truncates summary to 280 chars", () => {
    const { deps, calls } = makeDeps();
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
    const text = calls.enqueueSystemEvent.mock.calls[0]![0] as string;
    // Header + newline + 280 'x' chars.
    expect(text).toMatch(/\[langgraph:decision\] long-event\n/);
    expect(text.split("\n")[1]!.length).toBe(280);
  });
});
