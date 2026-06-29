import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetFlowWakeModelForTest,
  __resetInvalidMilestoneModelFlowsForTest,
  __resetTerminatedFlowsForTest,
  processEvent,
  type WebhookHandlerDeps,
} from "./webhook-handler.js";
import { makeFakeDeps } from "./test-harness.js";
import type { WakeAgentParams } from "./wake-agent.js";

// Reset the terminal latch before every test so module-level state from a
// terminal-kind processEvent call (e.g. processEvent — terminal describe) does
// not bleed into later describes that reuse the same flow_id.
beforeEach(() => {
  __resetTerminatedFlowsForTest();
});

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

describe("processEvent — terminal finish() revision-conflict hardening (#101)", () => {
  const terminalBody = {
    kind: "terminal" as const,
    flow_id: "f1",
    title: "ok",
    summary: "deploy succeeded",
    data: { exit_code: 0 },
  };

  it("on finish() revision conflict, re-reads the revision and retries finish() so terminal state still commits", () => {
    const { deps, calls } = makeDeps();
    const logger = { info: vi.fn(), warn: vi.fn() };
    deps.logger = logger;
    // Top read: revision 1 (non-terminal). Reread in catch: revision 2 (a
    // concurrent milestone runTask bumped it). finish() throws on the first
    // call (stale expectedRevision), succeeds on the revision-refreshed retry.
    calls.get
      .mockReturnValueOnce({
        owner_key: "agent:main:dm:user",
        revision: 1,
        status: "running",
        stateJson: { decision_only: false },
      })
      .mockReturnValueOnce({
        owner_key: "agent:main:dm:user",
        revision: 2,
        status: "running",
        stateJson: { decision_only: false },
      });
    calls.finish.mockImplementationOnce(() => {
      throw new Error("revision conflict: expected 1");
    });

    const result = processEvent({
      body: terminalBody,
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });

    // Did not throw / 500 — returned ok.
    expect(result).toMatchObject({ status: "ok" });
    // finish() called twice; the retry used the refreshed revision.
    expect(calls.finish).toHaveBeenCalledTimes(2);
    expect((calls.finish.mock.calls[1]![0] as { expectedRevision: number }).expectedRevision).toBe(
      2,
    );
    expect(logger.warn).not.toHaveBeenCalled();
    // Terminal still wakes once.
    expect(calls.wake).toHaveBeenCalledOnce();
  });

  it("normalizes a non-numeric reread revision before retrying finish() (string revision -> Number)", () => {
    const { deps, calls } = makeDeps();
    const logger = { info: vi.fn(), warn: vi.fn() };
    deps.logger = logger;
    // flows.get() is typed Record<string, unknown>; the reread revision can
    // come back as a string. It must be Number()-normalized identically to
    // flowRevision, otherwise the equality guard mis-fires and a non-number
    // expectedRevision is passed into finish(), defeating the hardening.
    calls.get
      .mockReturnValueOnce({
        owner_key: "agent:main:dm:user",
        revision: 1,
        status: "running",
        stateJson: { decision_only: false },
      })
      .mockReturnValueOnce({
        owner_key: "agent:main:dm:user",
        revision: "2",
        status: "running",
        stateJson: { decision_only: false },
      });
    calls.finish.mockImplementationOnce(() => {
      throw new Error("revision conflict: expected 1");
    });

    const result = processEvent({
      body: terminalBody,
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });

    expect(result).toMatchObject({ status: "ok" });
    expect(calls.finish).toHaveBeenCalledTimes(2);
    // Retry got a real number 2, not the string "2".
    const retryRevision = (calls.finish.mock.calls[1]![0] as { expectedRevision: unknown })
      .expectedRevision;
    expect(retryRevision).toBe(2);
    expect(typeof retryRevision).toBe("number");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("on finish() failure with no fresh revision, swallows + warns instead of 500ing (latch still suppresses replays)", () => {
    const { deps, calls } = makeDeps();
    const logger = { info: vi.fn(), warn: vi.fn() };
    deps.logger = logger;
    // Revision does not move between top read and reread (1 -> 1), so a plain
    // retry would hit the same conflict — swallow rather than rethrow.
    calls.get.mockReturnValue({
      owner_key: "agent:main:dm:user",
      revision: 1,
      status: "running",
      stateJson: { decision_only: false },
    });
    calls.finish.mockImplementation(() => {
      throw new Error("revision conflict: expected 1");
    });

    const result = processEvent({
      body: terminalBody,
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });

    // Swallowed: returns ok (no 500 -> no LangGraph re-delivery storm).
    expect(result).toMatchObject({ status: "ok" });
    // No revision-refresh retry attempted (revision unchanged).
    expect(calls.finish).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]![0]).toMatch(/terminal finish\(\) failed/);
  });

  it("latch is still set when finish() fails — the next frame for the flow is dropped", () => {
    const { deps, calls } = makeDeps();
    deps.logger = { info: vi.fn(), warn: vi.fn() };
    calls.get.mockReturnValue({
      owner_key: "agent:main:dm:user",
      revision: 1,
      status: "running",
      stateJson: { decision_only: false },
    });
    calls.finish.mockImplementation(() => {
      throw new Error("revision conflict");
    });

    processEvent({ body: terminalBody, sessionKey: "agent:main:dm:user", flowRevision: 1, deps });
    const wakeCallsAfterTerminal = calls.wake.mock.calls.length;

    // A replayed milestone for the same flow after the (failed-finish) terminal
    // must be dropped by the latch, despite the SDK status never committing.
    const result = processEvent({
      body: { kind: "milestone", flow_id: "f1", title: "merge_gate:started", summary: "" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(result).toMatchObject({ action: "ignored:post-terminal" });
    expect(calls.wake.mock.calls.length).toBe(wakeCallsAfterTerminal);
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

  it("terminal event GCs the per-flow rejection cache entry (post-terminal frame dropped by latch)", () => {
    // Note (issue #101): the invalidMilestoneModelFlows GC still runs at
    // terminal (the delete call in the code is unchanged), but with the
    // per-flow terminal latch any post-terminal milestone for the same
    // flow_id is dropped before reaching the model-forwarding path, so
    // the GC is no longer directly observable through processEvent.
    // This test confirms: (a) the terminal fires finish+wake normally,
    // (b) a post-terminal milestone for the same flow is dropped by the
    // latch (not by the invalidMilestoneModelFlows cache).
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: { decision_only: false, milestone_model: "bad-model" },
      },
    });

    // First milestone + simulate model rejection.
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

    // Terminal arrives for same flow — latches it and fires finish+wake.
    processEvent({
      body: { kind: "terminal", flow_id: "flow-gc", title: "done" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.finish).toHaveBeenCalledOnce();
    // Two wake calls so far: first milestone + terminal.
    expect(calls.wake).toHaveBeenCalledTimes(2);

    // Post-terminal milestone for the same flow — latch drops it.
    const result = processEvent({
      body: { kind: "milestone", flow_id: "flow-gc", title: "x" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(result).toEqual({ status: "ok", action: "ignored:post-terminal" });
    // No additional wake beyond the two above.
    expect(calls.wake).toHaveBeenCalledTimes(2);
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

describe("processEvent — per-flow terminal latch (issue #101)", () => {
  beforeEach(() => {
    __resetInvalidMilestoneModelFlowsForTest();
    __resetTerminatedFlowsForTest();
  });

  it("(a) latch drops post-terminal milestone even when SDK status is still non-terminal", () => {
    // Simulates the finish()-revision-conflict scenario: the flow's SDK
    // record status remains "running" (non-terminal) but the latch should
    // drop the subsequent milestone frame regardless.
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: { status: "running" },
    });

    // First: process a terminal event — latches flow F internally.
    processEvent({
      body: { kind: "terminal", flow_id: "latch-f", title: "done" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });

    // Reset wake call count so we can assert cleanly on the milestone.
    calls.wake.mockClear();
    calls.runTask.mockClear();

    // Now: process a milestone for the same flow. The mocked get() still
    // returns status="running" (non-terminal), but the latch should catch it.
    const result = processEvent({
      body: { kind: "milestone", flow_id: "latch-f", title: "node:recap", summary: "late" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });

    expect(result).toEqual({ status: "ok", action: "ignored:post-terminal" });
    expect(calls.runTask).not.toHaveBeenCalled();
    expect(calls.wake).not.toHaveBeenCalled();
  });

  it("(b) replayed terminal after first terminal: second terminal ignored, wake called only once", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: { status: "running" },
    });

    // First terminal — should succeed and wake.
    processEvent({
      body: { kind: "terminal", flow_id: "latch-b", title: "done" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake).toHaveBeenCalledOnce();

    // Second terminal for same flow — latch drops it.
    const result = processEvent({
      body: { kind: "terminal", flow_id: "latch-b", title: "done-replay" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });

    expect(result).toEqual({ status: "ok", action: "ignored:post-terminal" });
    // Wake was called only once total (from the first terminal).
    expect(calls.wake).toHaveBeenCalledOnce();
    expect(calls.finish).toHaveBeenCalledOnce();
  });

  it("(c) post-terminal hitl frame is dropped by latch", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: { status: "running" },
    });

    processEvent({
      body: { kind: "terminal", flow_id: "latch-c", title: "done" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    calls.wake.mockClear();
    calls.setWaiting.mockClear();

    const result = processEvent({
      body: { kind: "hitl", flow_id: "latch-c", title: "stale-interrupt", interrupt_id: "i-99" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });

    expect(result).toEqual({ status: "ok", action: "ignored:post-terminal" });
    expect(calls.setWaiting).not.toHaveBeenCalled();
    expect(calls.wake).not.toHaveBeenCalled();
  });

  it("(d) latch set even if finish() throws — subsequent frame still dropped", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: { status: "running" },
    });

    // Make finish() throw to simulate a revision conflict.
    calls.finish.mockImplementation(() => {
      throw new Error("revision_conflict");
    });

    // finish() throws (revision conflict), but production swallows it by
    // design (#101) to avoid 500/replay storms — so processEvent does NOT
    // throw. The latch is set synchronously before finish(), so the
    // subsequent frame is still dropped regardless.
    expect(() =>
      processEvent({
        body: { kind: "terminal", flow_id: "latch-d", title: "done" },
        sessionKey: "agent:main:dm:user",
        flowRevision: 1,
        deps,
      }),
    ).not.toThrow();

    // Restore finish so the subsequent frame doesn't also throw.
    calls.finish.mockImplementation(() => undefined);
    calls.wake.mockClear();
    calls.runTask.mockClear();

    // Subsequent frame for same flow should be dropped by the latch.
    const result = processEvent({
      body: { kind: "milestone", flow_id: "latch-d", title: "node:recap" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });

    expect(result).toEqual({ status: "ok", action: "ignored:post-terminal" });
    expect(calls.runTask).not.toHaveBeenCalled();
    expect(calls.wake).not.toHaveBeenCalled();
  });

  it("(e) cross-flow isolation: terminal for F does not drop frames for G", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: { status: "running" },
    });

    // Terminate flow F.
    processEvent({
      body: { kind: "terminal", flow_id: "latch-F", title: "done" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    calls.wake.mockClear();
    calls.runTask.mockClear();

    // A milestone for a DIFFERENT flow G should process normally.
    const result = processEvent({
      body: { kind: "milestone", flow_id: "latch-G", title: "node:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });

    expect(result).toEqual({ status: "ok", action: "wake-light" });
    expect(calls.runTask).toHaveBeenCalledOnce();
    expect(calls.wake).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Per-flow wake-model pin (issue #101 ask #4 — Direction A)
// ---------------------------------------------------------------------------

describe("processEvent — per-flow wake-model pin (#101 ask #4)", () => {
  beforeEach(() => {
    __resetFlowWakeModelForTest();
    __resetInvalidMilestoneModelFlowsForTest();
    __resetTerminatedFlowsForTest();
  });

  // ─── Core fix: first-wake-model-wins ───────────────────────────────────

  it("flow with milestone_model=sonnet: first milestone wake uses sonnet; subsequent decision wake ALSO uses sonnet (pinned)", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });

    // First wake: milestone → pins to sonnet.
    processEvent({
      body: { kind: "milestone", flow_id: "pin-core", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[0]![0].model).toBe("anthropic/claude-sonnet-4-6");

    // Second wake: decision → should use the pin (sonnet), NOT the session primary.
    processEvent({
      body: { kind: "decision", flow_id: "pin-core", title: "needs:input", summary: "approve?" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[1]![0].model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("flow with milestone_model=sonnet: terminal wake ALSO uses sonnet (pinned)", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });

    // First wake: milestone → pins to sonnet.
    processEvent({
      body: { kind: "milestone", flow_id: "pin-terminal", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[0]![0].model).toBe("anthropic/claude-sonnet-4-6");

    // Terminal wake → should use the pin.
    processEvent({
      body: { kind: "terminal", flow_id: "pin-terminal", title: "done", summary: "ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[1]![0].model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("flow with milestone_model=sonnet: hitl wake ALSO uses sonnet (pinned)", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });

    // First wake: milestone → pins to sonnet.
    processEvent({
      body: { kind: "milestone", flow_id: "pin-hitl", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });

    // HITL wake → should use the pin.
    processEvent({
      body: {
        kind: "hitl",
        flow_id: "pin-hitl",
        title: "approval-gate",
        interrupt_id: "i-42",
        summary: "approve?",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[1]![0].model).toBe("anthropic/claude-sonnet-4-6");
  });

  // ─── No milestone_model: pins primary (undefined) ──────────────────────

  it("flow with NO milestone_model: every wake uses undefined (session primary) — no change, no thrash", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: { decision_only: false }, // no milestone_model
      },
    });

    processEvent({
      body: { kind: "milestone", flow_id: "pin-no-model", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[0]![0].model).toBeUndefined();

    processEvent({
      body: {
        kind: "decision",
        flow_id: "pin-no-model",
        title: "needs:input",
        summary: "approve?",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[1]![0].model).toBeUndefined();
  });

  // ─── First wake is a decision: pins primary; later milestone stays primary ─

  it("flow whose first wake is a decision pins primary; later milestone wake reuses primary (does NOT switch to milestone_model mid-flow)", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });

    // First wake: decision (no milestone_model override) → pins primary (undefined).
    processEvent({
      body: {
        kind: "decision",
        flow_id: "pin-decision-first",
        title: "needs:input",
        summary: "approve?",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[0]![0].model).toBeUndefined();

    // Second wake: milestone (has milestone_model) → pin was set to undefined, reuses it.
    processEvent({
      body: { kind: "milestone", flow_id: "pin-decision-first", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    // Pin was set to undefined on the first wake — milestone must NOT switch to sonnet.
    expect(calls.wake.mock.calls[1]![0].model).toBeUndefined();
  });

  // ─── wakeModelPolicy="session-primary" ────────────────────────────────

  it('wakeModelPolicy="session-primary": milestone wake ignores milestone_model and uses session primary', () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });
    deps.wakeModelPolicy = "session-primary";

    processEvent({
      body: { kind: "milestone", flow_id: "pin-policy-sp", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    // Despite milestone_model being set, session-primary policy ignores it.
    expect(calls.wake.mock.calls[0]![0].model).toBeUndefined();
  });

  it('wakeModelPolicy="session-primary": subsequent decision also uses session primary (no pin established)', () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });
    deps.wakeModelPolicy = "session-primary";

    processEvent({
      body: { kind: "milestone", flow_id: "pin-policy-sp2", title: "x" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    processEvent({
      body: {
        kind: "decision",
        flow_id: "pin-policy-sp2",
        title: "needs:input",
        summary: "approve?",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[0]![0].model).toBeUndefined();
    expect(calls.wake.mock.calls[1]![0].model).toBeUndefined();
  });

  // ─── Cross-flow isolation ──────────────────────────────────────────────

  it("cross-flow isolation: flow A's pin does not affect flow B", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });

    // Flow A: first wake is milestone → pins sonnet.
    processEvent({
      body: { kind: "milestone", flow_id: "pin-flow-A", title: "build:ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[0]![0].model).toBe("anthropic/claude-sonnet-4-6");

    // Flow B: first wake is decision → natural model is undefined; pins undefined.
    processEvent({
      body: {
        kind: "decision",
        flow_id: "pin-flow-B",
        title: "needs:input",
        summary: "approve?",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    // Flow B should get its own pin (undefined from decision), not A's pin.
    expect(calls.wake.mock.calls[1]![0].model).toBeUndefined();

    // Flow A: subsequent decision should still use A's pin (sonnet).
    processEvent({
      body: {
        kind: "decision",
        flow_id: "pin-flow-A",
        title: "approve?",
        summary: "yes?",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[2]![0].model).toBe("anthropic/claude-sonnet-4-6");
  });

  // ─── Rejected milestone_model is not re-pinned ────────────────────────

  it("rejected milestone_model (invalidMilestoneModelFlows) is not re-pinned; subsequent wakes use session primary", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: { decision_only: false, milestone_model: "bad-model" },
      },
    });

    // First milestone wake: natural model = bad-model.
    processEvent({
      body: { kind: "milestone", flow_id: "pin-rejected", title: "a" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[0]![0].model).toBe("bad-model");

    // Simulate gateway rejection — adds the flow to invalidMilestoneModelFlows.
    const onInvalidModel = calls.wake.mock.calls[0]![1]?.onInvalidModel;
    expect(typeof onInvalidModel).toBe("function");
    onInvalidModel?.({ model: "bad-model", cliError: "is not allowed" });

    // Second milestone: natural model now undefined (bad-model rejected).
    // The pin was NOT set on the first wake (first wake used bad-model but pin
    // is set from naturalModel; after invalidation naturalModel becomes undefined
    // for subsequent wakes). Verify the second wake uses undefined.
    processEvent({
      body: { kind: "milestone", flow_id: "pin-rejected", title: "b" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[1]![0].model).toBeUndefined();

    // Subsequent decision wake: also gets undefined (not bad-model).
    processEvent({
      body: {
        kind: "decision",
        flow_id: "pin-rejected",
        title: "needs:input",
        summary: "approve?",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[2]![0].model).toBeUndefined();
  });

  // ─── GC on terminal ───────────────────────────────────────────────────

  it("pin map entry is GC'd on terminal; post-terminal frames are dropped by latch (not by pin)", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });

    // Pin the model.
    processEvent({
      body: { kind: "milestone", flow_id: "pin-gc", title: "x" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });

    // Terminal: should use the pinned model, THEN GC the pin.
    processEvent({
      body: { kind: "terminal", flow_id: "pin-gc", title: "done", summary: "ok" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    // Terminal wake used the pinned model.
    expect(calls.wake.mock.calls[1]![0].model).toBe("anthropic/claude-sonnet-4-6");

    // Post-terminal milestone: dropped by latch (not pin map).
    const result = processEvent({
      body: { kind: "milestone", flow_id: "pin-gc", title: "replay" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(result).toEqual({ status: "ok", action: "ignored:post-terminal" });
    expect(calls.wake).toHaveBeenCalledTimes(2); // Only the original two wakes.
  });

  // ─── __resetFlowWakeModelForTest clears state between cases ───────────

  it("__resetFlowWakeModelForTest clears pins between test cases", () => {
    const { deps, calls } = makeFakeDeps({
      decisionOnly: false,
      flowRecord: {
        stateJson: {
          decision_only: false,
          milestone_model: "anthropic/claude-sonnet-4-6",
        },
      },
    });

    // Pin sonnet on flow "reuse".
    processEvent({
      body: { kind: "milestone", flow_id: "reuse", title: "x" },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    expect(calls.wake.mock.calls[0]![0].model).toBe("anthropic/claude-sonnet-4-6");

    // Clear pin state — simulates beforeEach reset.
    __resetFlowWakeModelForTest();
    calls.wake.mockClear();

    // Same flow "reuse" now starts fresh: a decision wake computes the natural
    // model (undefined for decision) and pins that.
    processEvent({
      body: {
        kind: "decision",
        flow_id: "reuse",
        title: "needs:input",
        summary: "approve?",
      },
      sessionKey: "agent:main:dm:user",
      flowRevision: 1,
      deps,
    });
    // Pin was cleared; new first-wake for "reuse" is a decision → natural is undefined.
    expect(calls.wake.mock.calls[0]![0].model).toBeUndefined();
  });
});
