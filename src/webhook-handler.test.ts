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

describe("processEvent — reply hint from sessionKey", () => {
  it("prepends a Slack-thread reply hint when sessionKey carries :slack:channel:<ch>:thread:<ts>", () => {
    const { deps, calls } = makeDeps();
    processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "coder:done" },
      sessionKey:
        "agent:main:slack:channel:c0ba88ychfz:thread:1781634334.310769",
      flowRevision: 1,
      deps,
    });
    const wakeArgs = calls.wake.mock.calls[0]![0];
    expect(wakeArgs.message).toMatch(/^\[reply-hint\]/);
    expect(wakeArgs.message).toContain('threadId="1781634334.310769"');
    expect(wakeArgs.message).toContain("channel=c0ba88ychfz");
    expect(wakeArgs.message).toMatch(
      /\[langgraph:milestone\] coder:done/,
    );
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

describe("processEvent — terminated-flow guard (#10, #16)", () => {
  function makeDepsWithFlowStatus(flowStatus: string) {
    const calls = {
      runTask: vi.fn<(...args: AnyArgs) => unknown>(),
      setWaiting: vi.fn<(...args: AnyArgs) => unknown>(),
      finish: vi.fn<(...args: AnyArgs) => unknown>(),
      get: vi.fn<(flowId: string) => Record<string, unknown> | undefined>(
        () => ({
          owner_key: "agent:main:dm:user",
          revision: 5,
          status: flowStatus,
        }),
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
    const calls = {
      runTask: vi.fn<(...args: AnyArgs) => unknown>(),
      setWaiting: vi.fn<(...args: AnyArgs) => unknown>(),
      finish: vi.fn<(...args: AnyArgs) => unknown>(),
      get: vi.fn<(flowId: string) => Record<string, unknown> | undefined>(
        () => ({ owner_key: "agent:main:dm:user", revision: 1 }),
        // no status field
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
