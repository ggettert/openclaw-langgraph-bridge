import { describe, expect, it, vi } from "vitest";
import { processEvent, type WebhookHandlerDeps } from "./webhook-handler.js";
import type { WakeAgentParams } from "./wake-agent.js";

type AnyArgs = unknown[];

function makeDeps() {
  const calls = {
    runTask: vi.fn<(...args: AnyArgs) => unknown>(),
    setWaiting: vi.fn<(...args: AnyArgs) => unknown>(),
    finish: vi.fn<(...args: AnyArgs) => unknown>(),
    // decision_only=false so milestone tests that assert wake behaviour work.
    // Tests that specifically test decision_only=true use makeDepsWithDecisionOnly().
    get: vi.fn<(flowId: string) => Record<string, unknown> | undefined>(
      () => ({
        owner_key: "agent:main:dm:user",
        revision: 1,
        stateJson: { decision_only: false },
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
    // Unit-test queue: call run() synchronously (fire-and-forget) so that
    // assertions on calls.wake don't need to await async queue drain.
    enqueueWake: (_key, run) => {
      void run();
    },
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

    const get = vi.fn<(flowId: string) => Record<string, unknown> | undefined>(
      () => ({ owner_key: sessionKey, revision: 1, stateJson: { decision_only: false } }),
    );
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

describe("processEvent — decision_only flag (#6)", () => {
  function makeDepsWithDecisionOnly(decisionOnly: boolean) {
    const calls = {
      runTask: vi.fn<(...args: AnyArgs) => unknown>(),
      setWaiting: vi.fn<(...args: AnyArgs) => unknown>(),
      finish: vi.fn<(...args: AnyArgs) => unknown>(),
      // Embed decision_only in stateJson so processEvent can read it.
      get: vi.fn<(flowId: string) => Record<string, unknown> | undefined>(
        () => ({
          owner_key: "agent:main:dm:user",
          revision: 1,
          stateJson: { workflow: "fleet", decision_only: decisionOnly },
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
      enqueueWake: (_key, run) => { void run(); },
    };
    return { deps, calls };
  }

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
    expect(calls.wake).not.toHaveBeenCalled();   // but no wake
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
    const calls = {
      runTask: vi.fn<(...args: AnyArgs) => unknown>(),
      setWaiting: vi.fn<(...args: AnyArgs) => unknown>(),
      finish: vi.fn<(...args: AnyArgs) => unknown>(),
      get: vi.fn<(flowId: string) => Record<string, unknown> | undefined>(
        () => ({ owner_key: "agent:main:dm:user", revision: 1 }),
        // no stateJson
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
      enqueueWake: (_key, run) => { void run(); },
    };
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
    const calls = {
      runTask: vi.fn<(...args: AnyArgs) => unknown>(),
      setWaiting: vi.fn<(...args: AnyArgs) => unknown>(),
      finish: vi.fn<(...args: AnyArgs) => unknown>(),
      get: vi.fn<(flowId: string) => Record<string, unknown> | undefined>(
        () => ({
          owner_key: "agent:main:dm:user",
          revision: 1,
          stateJson: { workflow: "fleet" }, // stateJson present but no decision_only key
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
      enqueueWake: (_key, run) => { void run(); },
    };
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
    // Use decision_only=false so milestone fires a wake (tests the guard, not the flag).
    const calls = {
      runTask: vi.fn<(...args: AnyArgs) => unknown>(),
      setWaiting: vi.fn<(...args: AnyArgs) => unknown>(),
      finish: vi.fn<(...args: AnyArgs) => unknown>(),
      get: vi.fn<(flowId: string) => Record<string, unknown> | undefined>(
        () => ({ owner_key: "agent:main:dm:user", revision: 1, stateJson: { decision_only: false } }),
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
