import { describe, expect, it, vi } from "vitest";
import { processEvent, type WebhookHandlerDeps } from "./webhook-handler.js";
import type { WakeAgentParams } from "./wake-agent.js";

type AnyArgs = unknown[];

function makeDeps() {
  const calls = {
    runTask: vi.fn<(...args: AnyArgs) => unknown>(),
    setWaiting: vi.fn<(...args: AnyArgs) => unknown>(),
    finish: vi.fn<(...args: AnyArgs) => unknown>(),
    get: vi.fn<(flowId: string) => Record<string, unknown> | undefined>(
      () => ({ owner_key: "agent:main:dm:user", revision: 1 }),
    ),
    wake: vi.fn<(params: WakeAgentParams, deps?: unknown) => void>(),
  };
  const deps: WebhookHandlerDeps = {
    expectedToken: "secret",
    pluginId: "openclaw-langgraph-bridge",
    agentId: "main",
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
  };
  return { deps, calls };
}

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
  it("truncates summary to 280 chars in wake message", () => {
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
    const wakeArgs = calls.wake.mock.calls[0]![0];
    expect(wakeArgs.message).toMatch(/\[langgraph:decision\] long-event\n/);
    expect(wakeArgs.message.split("\n")[1]!.length).toBe(280);
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
