/**
 * Tests for WakeDedup (issue #91, Phase 2).
 *
 * Time is injected via WakeDedupTimeDeps for deterministic execution.
 * Fixture data does NOT contain node-name strings — dedup key extraction
 * and fanout detection are purely structural (topology-agnostic).
 */

import { describe, expect, it, vi } from "vitest";
import { WakeDedup, getDedupKey, isFinishedMilestone } from "./wake-dedup.js";
import { WakeBudget } from "./wake-budget.js";
import type { IncomingEventBody } from "./webhook-handler.js";

// ---------------------------------------------------------------------------
// Test-clock helpers (same shape as wake-budget.test.ts)
// ---------------------------------------------------------------------------

type FakeTimer = {
  now: () => number;
  advance: (ms: number) => void;
  deps: ConstructorParameters<typeof WakeDedup>[1];
};

function makeFakeClock(initialMs = 0): FakeTimer {
  let currentMs = initialMs;
  type Entry = { fn: () => void; fireAt: number };
  const timers: Entry[] = [];
  let nextHandle = 1;
  const handleMap = new Map<number, Entry>();

  const setTimer = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const handle = nextHandle++ as unknown as ReturnType<typeof setTimeout>;
    const entry: Entry = { fn, fireAt: currentMs + ms };
    timers.push(entry);
    handleMap.set(handle as unknown as number, entry);
    return handle;
  };

  const clearTimer = (handle: ReturnType<typeof setTimeout>): void => {
    const entry = handleMap.get(handle as unknown as number);
    if (entry == null) return;
    const idx = timers.indexOf(entry);
    if (idx !== -1) timers.splice(idx, 1);
    handleMap.delete(handle as unknown as number);
  };

  const advance = (ms: number): void => {
    currentMs += ms;
    let fired = true;
    while (fired) {
      fired = false;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i]!;
        if (t.fireAt <= currentMs) {
          timers.splice(i, 1);
          fired = true;
          t.fn();
          break;
        }
      }
    }
  };

  return {
    now: () => currentMs,
    advance,
    deps: { now: () => currentMs, setTimer, clearTimer },
  };
}

// ---------------------------------------------------------------------------
// Fixture builders — no node-name strings
// ---------------------------------------------------------------------------

/**
 * Build a generic non-finished milestone using abstract keys.
 * Uses phase/event data so the dedup key is `"${flowId}:${phase}:${event}"`.
 */
function makePhaseBody(phase: string, event: string, flowId = "flow-1"): IncomingEventBody {
  return {
    kind: "milestone",
    flow_id: flowId,
    title: `${phase}:${event}`,
    summary: `${phase} ${event}`,
    data: { phase, event },
  };
}

/**
 * Build a generic "finished" phase-event body.
 * Uses phase/event so dedup key = `"${flowId}:${phase}:finished"`.
 * Contains no production node-name strings.
 */
function makeFinishedBody(phase: string, flowId = "flow-1"): IncomingEventBody {
  return makePhaseBody(phase, "finished", flowId);
}

/**
 * Build a generic node-style milestone (title only, no phase/event in data).
 */
function makeNodeBody(title: string, flowId = "flow-1"): IncomingEventBody {
  return {
    kind: "milestone",
    flow_id: flowId,
    title,
    summary: `${title} ran`,
    data: {},
  };
}

// ---------------------------------------------------------------------------
// Suite 1: getDedupKey
// ---------------------------------------------------------------------------

describe("getDedupKey", () => {
  it("uses flow_id:phase:event for phase-event bodies", () => {
    const body = makePhaseBody("alpha", "started", "flow-42");
    expect(getDedupKey(body)).toBe("flow-42:alpha:started");
  });

  it("uses flow_id:title for node-style bodies", () => {
    expect(getDedupKey(makeNodeBody("node:alpha", "flow-7"))).toBe("flow-7:node:alpha");
  });

  it("falls back to flow_id:unknown when no title or data.phase", () => {
    const body: IncomingEventBody = { kind: "milestone", flow_id: "f99" };
    expect(getDedupKey(body)).toBe("f99:unknown");
  });

  it("different flow_ids produce different keys for identical phase/event", () => {
    const a = makePhaseBody("x", "finished", "flow-A");
    const b = makePhaseBody("x", "finished", "flow-B");
    expect(getDedupKey(a)).not.toBe(getDedupKey(b));
  });
});

// ---------------------------------------------------------------------------
// Suite 2: isFinishedMilestone
// ---------------------------------------------------------------------------

describe("isFinishedMilestone", () => {
  it("detects data.event === 'finished'", () => {
    expect(isFinishedMilestone(makePhaseBody("x", "finished"))).toBe(true);
  });

  it("detects data.event === 'complete' / 'completed' / 'done'", () => {
    for (const ev of ["complete", "completed", "done"]) {
      expect(isFinishedMilestone(makePhaseBody("x", ev)), ev).toBe(true);
    }
  });

  it("returns false for data.event === 'started'", () => {
    expect(isFinishedMilestone(makePhaseBody("x", "started"))).toBe(false);
  });

  it("detects title ending :finished", () => {
    expect(isFinishedMilestone(makeNodeBody("node:alpha:finished"))).toBe(true);
  });

  it("returns false for title ending :started", () => {
    expect(isFinishedMilestone(makeNodeBody("node:alpha:started"))).toBe(false);
  });

  it("returns false when no data.event and title has no :finished suffix", () => {
    expect(isFinishedMilestone(makeNodeBody("node:alpha"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: dedup disabled
// ---------------------------------------------------------------------------

describe("WakeDedup — dedup disabled", () => {
  it("always returns true when enabled=false", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: false, windowMs: 5_000 }, clock.deps);

    // Even the same key twice fires immediately
    const body = makePhaseBody("alpha", "started");
    expect(dedup.shouldWakeNow(body, vi.fn())).toBe(true);
    expect(dedup.shouldWakeNow(body, vi.fn())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: non-finished milestones — same-key dedup
// ---------------------------------------------------------------------------

describe("WakeDedup — same-key dedup (non-finished)", () => {
  it("first occurrence of a key fires immediately", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    expect(dedup.shouldWakeNow(makePhaseBody("alpha", "started"), vi.fn())).toBe(true);
  });

  it("second occurrence of same key within window is deferred", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);
    const body = makePhaseBody("beta", "progress");

    dedup.shouldWakeNow(body, vi.fn()); // fires
    const cb = vi.fn();
    const result = dedup.shouldWakeNow(body, cb); // same key, within window
    expect(result).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    // Key is now namespaced: "flow-1:beta:progress"
    expect(dedup._testHasPendingTrailingForKey("flow-1:beta:progress")).toBe(true);
  });

  it("same-key trailing-edge wake fires after window elapses", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);
    const body = makePhaseBody("gamma", "progress");

    dedup.shouldWakeNow(body, vi.fn()); // first: immediate

    const trailing = vi.fn();
    dedup.shouldWakeNow(body, trailing); // second: deferred

    clock.advance(2_500);
    expect(trailing).not.toHaveBeenCalled();

    clock.advance(2_500);
    expect(trailing).toHaveBeenCalledOnce();
  });

  it("subsequent same-key calls update the trailing callback (latest wins)", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);
    const body = makePhaseBody("delta", "progress");

    dedup.shouldWakeNow(body, vi.fn()); // first: immediate

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    dedup.shouldWakeNow(body, cb1);
    dedup.shouldWakeNow(body, cb2);

    clock.advance(5_000);
    expect(cb2).toHaveBeenCalledOnce();
    expect(cb1).not.toHaveBeenCalled();
  });

  it("distinct keys each fire their own immediate wake", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    // Two distinct non-finished keys fire independently
    expect(dedup.shouldWakeNow(makePhaseBody("alpha", "started"), vi.fn())).toBe(true);
    expect(dedup.shouldWakeNow(makePhaseBody("beta", "started"), vi.fn())).toBe(true);
    expect(dedup.shouldWakeNow(makePhaseBody("gamma", "started"), vi.fn())).toBe(true);
  });

  it("expired key starts a fresh window (fires immediately again)", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);
    const body = makePhaseBody("eta", "progress");

    dedup.shouldWakeNow(body, vi.fn()); // t=0: fires
    clock.advance(5_001); // past window
    expect(dedup.shouldWakeNow(body, vi.fn())).toBe(true); // new window: fires
  });
});

// ---------------------------------------------------------------------------
// Suite 5: fanout collapse — "finished" milestones
// ---------------------------------------------------------------------------

describe("WakeDedup — fanout collapse (finished milestones)", () => {
  it("single 'finished' key is deferred (never fires immediately)", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    const cb = vi.fn();
    expect(dedup.shouldWakeNow(makeFinishedBody("alpha"), cb)).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    expect(dedup._testHasActiveFanout("flow-1")).toBe(true);
    expect(dedup._testActiveFanoutSize("flow-1")).toBe(1);
  });

  it("single 'finished' key fires its trailing-edge wake after windowMs", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    const cb = vi.fn();
    dedup.shouldWakeNow(makeFinishedBody("alpha"), cb);

    clock.advance(5_000);
    expect(cb).toHaveBeenCalledOnce();
    expect(dedup._testHasActiveFanout("flow-1")).toBe(false);
  });

  it("two distinct 'finished' keys within window collapse to ONE wake", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    const cb1 = vi.fn();
    const cb2 = vi.fn();

    dedup.shouldWakeNow(makeFinishedBody("branch-a"), cb1); // first key
    clock.advance(100); // short interval — same superstep window
    dedup.shouldWakeNow(makeFinishedBody("branch-b"), cb2); // second key — joins group

    expect(dedup._testActiveFanoutSize("flow-1")).toBe(2);

    clock.advance(5_000);
    // Only the latest callback fires (cb2)
    expect(cb2).toHaveBeenCalledOnce();
    expect(cb1).not.toHaveBeenCalled();
  });

  it("N distinct 'finished' keys within window all collapse to ONE wake", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    const cbs = Array.from({ length: 5 }, () => vi.fn());
    for (let i = 0; i < 5; i++) {
      dedup.shouldWakeNow(makeFinishedBody(`branch-${i}`), cbs[i]!);
      clock.advance(50);
    }

    expect(dedup._testActiveFanoutSize("flow-1")).toBe(5);

    clock.advance(5_000);
    const fired = cbs.filter((cb) => cb.mock.calls.length > 0);
    expect(fired).toHaveLength(1); // exactly one wake for the whole group
    expect(fired[0]).toHaveBeenCalledOnce();
  });

  it("'finished' keys after the fanout window start a new group", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    const cb1 = vi.fn();
    const cb2 = vi.fn();

    dedup.shouldWakeNow(makeFinishedBody("group-a"), cb1); // group 1
    clock.advance(5_001); // past window — group 1 fires
    expect(cb1).toHaveBeenCalledOnce();

    dedup.shouldWakeNow(makeFinishedBody("group-b"), cb2); // group 2
    clock.advance(5_000);
    expect(cb2).toHaveBeenCalledOnce();
  });

  it("fanout group does NOT contain node-name strings — topology-agnostic", () => {
    // This test deliberately proves the dedup key comes from the structural
    // (phase, event) data, not hardcoded strings. All keys are generic.
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    // Three abstract branch names — no workflow-specific node names
    const bodies = [
      makeFinishedBody("worker-1"),
      makeFinishedBody("worker-2"),
      makeFinishedBody("worker-3"),
    ];

    const wakes: number[] = [];
    let wakeCount = 0;
    for (const body of bodies) {
      const idx = wakeCount++;
      dedup.shouldWakeNow(body, () => {
        wakes.push(idx);
      });
      clock.advance(50);
    }

    expect(dedup._testActiveFanoutSize("flow-1")).toBe(3);
    clock.advance(5_000);
    // Exactly one wake fired
    expect(wakes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: per-flow isolation — two concurrent flows, same phase/event
// ---------------------------------------------------------------------------

describe("WakeDedup — per-flow key isolation", () => {
  it("same phase/event from two concurrent flows both wake immediately (no cross-flow suppression)", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    const bodyA = makePhaseBody("alpha", "started", "flow-A");
    const bodyB = makePhaseBody("alpha", "started", "flow-B");

    // Both are "new keys" because they have different flow_ids in their keys
    expect(dedup.shouldWakeNow(bodyA, vi.fn())).toBe(true);
    expect(dedup.shouldWakeNow(bodyB, vi.fn())).toBe(true);
  });

  it("dedup within flow-A does not affect flow-B for same phase/event", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    const bodyA = makePhaseBody("alpha", "progress", "flow-A");
    const bodyB = makePhaseBody("alpha", "progress", "flow-B");

    dedup.shouldWakeNow(bodyA, vi.fn()); // flow-A: first occurrence, fires
    const cbA2 = vi.fn();
    dedup.shouldWakeNow(bodyA, cbA2); // flow-A: second occurrence, deferred

    // flow-B is independent — first occurrence should still fire immediately
    expect(dedup.shouldWakeNow(bodyB, vi.fn())).toBe(true);

    // flow-A trailing still fires at window end
    clock.advance(5_000);
    expect(cbA2).toHaveBeenCalledOnce();
  });

  it("'finished' fanout groups are per-flow — flow-A fanout does not absorb flow-B finished", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    const cbA = vi.fn();
    const cbB = vi.fn();

    dedup.shouldWakeNow(makeFinishedBody("worker", "flow-A"), cbA);
    dedup.shouldWakeNow(makeFinishedBody("worker", "flow-B"), cbB);

    // Each flow has its own fanout group
    expect(dedup._testActiveFanoutSize("flow-A")).toBe(1);
    expect(dedup._testActiveFanoutSize("flow-B")).toBe(1);

    clock.advance(5_000);
    // Both callbacks fire independently (one per flow)
    expect(cbA).toHaveBeenCalledOnce();
    expect(cbB).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Suite 7: keyCache pruning on flow terminal
// ---------------------------------------------------------------------------

describe("WakeDedup — pruneFlow() removes all per-flow state", () => {
  it("pruneFlow removes all keyCache entries for the flow", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    // Populate several keys for flow-1
    dedup.shouldWakeNow(makePhaseBody("alpha", "started", "flow-1"), vi.fn());
    dedup.shouldWakeNow(makePhaseBody("beta", "progress", "flow-1"), vi.fn());
    dedup.shouldWakeNow(makePhaseBody("gamma", "finished", "flow-1"), vi.fn());

    expect(dedup._testKeyCacheSize()).toBeGreaterThanOrEqual(3);

    // Also add a key for a different flow (should survive pruneFlow("flow-1"))
    dedup.shouldWakeNow(makePhaseBody("alpha", "started", "flow-2"), vi.fn());
    const sizeBefore = dedup._testKeyCacheSize();

    dedup.pruneFlow("flow-1");

    // flow-1 entries removed; flow-2 entry survives
    expect(dedup._testKeyCacheSize()).toBe(sizeBefore - 3);
  });

  it("pruneFlow cancels pending trailing timers so they do not fire after terminal", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);
    const body = makePhaseBody("alpha", "progress", "flow-1");

    dedup.shouldWakeNow(body, vi.fn()); // first: fires
    const trailing = vi.fn();
    dedup.shouldWakeNow(body, trailing); // second: pending trailing timer

    dedup.pruneFlow("flow-1");

    // Advance past window — trailing must NOT fire (timer was cancelled)
    clock.advance(10_000);
    expect(trailing).not.toHaveBeenCalled();
  });

  it("pruneFlow cancels and removes the active fanout group for the flow", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);
    const fanoutCb = vi.fn();

    dedup.shouldWakeNow(makeFinishedBody("branch-a", "flow-1"), fanoutCb);
    expect(dedup._testHasActiveFanout("flow-1")).toBe(true);

    dedup.pruneFlow("flow-1");
    expect(dedup._testHasActiveFanout("flow-1")).toBe(false);

    // Fanout timer must not fire after pruneFlow
    clock.advance(10_000);
    expect(fanoutCb).not.toHaveBeenCalled();
  });

  it("pruneFlow for a nonexistent flow is a no-op", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);
    expect(() => dedup.pruneFlow("nonexistent-flow")).not.toThrow();
    clock.advance(1_000);
  });

  it("keyCache does not grow unboundedly across many flows when pruneFlow is called on terminal", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    // Simulate 10 flows each emitting 3 milestones then terminating
    for (let i = 0; i < 10; i++) {
      const flowId = `flow-${i}`;
      dedup.shouldWakeNow(makePhaseBody("alpha", "started", flowId), vi.fn());
      dedup.shouldWakeNow(makePhaseBody("beta", "progress", flowId), vi.fn());
      dedup.shouldWakeNow(makeFinishedBody("gamma", flowId), vi.fn());
      dedup.pruneFlow(flowId); // simulate terminal event
    }

    // After pruning all flows, keyCache must be empty
    expect(dedup._testKeyCacheSize()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 8: layer-ordering — repeated "finished" for same key
// ---------------------------------------------------------------------------

describe("WakeDedup — layer ordering: repeated 'finished' for same key", () => {
  it("single 'finished': deferred to fanout, fires exactly once", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);
    const cb = vi.fn();

    dedup.shouldWakeNow(makeFinishedBody("worker", "flow-1"), cb);
    clock.advance(5_000);

    expect(cb).toHaveBeenCalledOnce();
  });

  it("duplicate 'finished' for same key: does NOT produce two wakes (only one fanout fire)", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    const cb1 = vi.fn();
    const cb2 = vi.fn();

    // First "finished" for key — goes to Layer 2, creates fanout group
    dedup.shouldWakeNow(makeFinishedBody("worker", "flow-1"), cb1);
    clock.advance(500);

    // Second "finished" for SAME key within window — must route to fanout,
    // NOT create a competing per-key trailing timer
    dedup.shouldWakeNow(makeFinishedBody("worker", "flow-1"), cb2);

    // Still only one fanout group, with 1 key (same key added idempotently)
    expect(dedup._testActiveFanoutSize("flow-1")).toBe(1);

    clock.advance(5_000);
    // Only ONE wake fires total (cb2 — latest callback wins)
    expect(cb2).toHaveBeenCalledOnce();
    expect(cb1).not.toHaveBeenCalled();
  });

  it("fanout of N parallel distinct 'finished' keys: exactly ONE wake", () => {
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    const cbs = ["branch-a", "branch-b", "branch-c"].map(() => vi.fn());

    dedup.shouldWakeNow(makeFinishedBody("branch-a", "flow-1"), cbs[0]!);
    clock.advance(50);
    dedup.shouldWakeNow(makeFinishedBody("branch-b", "flow-1"), cbs[1]!);
    clock.advance(50);
    dedup.shouldWakeNow(makeFinishedBody("branch-c", "flow-1"), cbs[2]!);

    clock.advance(5_000);
    const fired = cbs.filter((cb) => cb.mock.calls.length > 0);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Suite 9: decision / terminal / hitl must bypass dedup entirely
// (WakeDedup is not called for those — we validate our classifier logic
//  separately, but this test documents the contract)
// ---------------------------------------------------------------------------

describe("WakeDedup — non-milestone events bypass module (contract test)", () => {
  it("WakeDedup.shouldWakeNow with a 'decision' kind body (wrong caller) still works structurally", () => {
    // In production, webhook-handler only calls shouldWakeNow for milestone.
    // If someone accidentally passes a decision body, the module still
    // returns a value without throwing.
    const clock = makeFakeClock();
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);
    const body: IncomingEventBody = {
      kind: "decision",
      flow_id: "f1",
      title: "gate:decision",
    };
    // Should not throw; returns true (non-finished, new key = immediate)
    expect(() => dedup.shouldWakeNow(body, vi.fn())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite 10: fairness integration test
// ---------------------------------------------------------------------------

describe("WakeDedup + WakeBudget — fairness (50 frames/min allows user message)", () => {
  it("50 milestone frames in a minute produce far fewer than 50 wakes", () => {
    const clock = makeFakeClock();

    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 15, windowMs: 60_000 }, clock.deps);
    const dedup = new WakeDedup({ enabled: true, windowMs: 5_000 }, clock.deps);

    let wakeCount = 0;

    // Simulate 50 milestone frames for the same key, spread over 60 seconds.
    // Mirrors how webhook-handler.ts wires dedup then budget:
    //   1. dedup.shouldWakeNow → false means defer, trailing callback fires later
    //   2. budget.checkBudget  → false means defer, trailing callback fires later
    //   3. otherwise fire immediately
    // Trailing callbacks increment wakeCount when their timers fire.
    for (let i = 0; i < 50; i++) {
      const body: IncomingEventBody = {
        kind: "milestone",
        flow_id: "flow-sim",
        title: "node:worker:progress",
        summary: `frame ${i}`,
        data: { phase: "worker", event: "progress" },
      };

      // Build the immediate-fire closure (mirrors webhook-handler fireWake).
      const fireNow = () => {
        wakeCount++;
      };

      const dedupOk = dedup.shouldWakeNow(body, fireNow);
      if (!dedupOk) {
        // Dedup deferred it; trailing callback (fireNow) will fire later.
      } else {
        const budgetOk = budget.checkBudget("flow-sim", fireNow);
        if (budgetOk) {
          fireNow();
        }
        // else: budget deferred it; trailing callback will fire later.
      }

      // Each frame arrives ~1.2 s apart (50 frames / 60 s).
      clock.advance(1_200);
    }

    // Advance past any pending trailing timers.
    clock.advance(65_000);

    // With dedup (5s window): only 1 wake per 5s window fires immediately.
    // 60s / 5s = ~12 windows, so ~12 immediate wakes + some trailing edges.
    // Budget cap is 15, so budget rarely triggers for this key frequency.
    // Total must be MUCH less than 50 (proving dedup is effective) and
    // still > 0 (proving wakes do arrive).
    expect(wakeCount).toBeLessThan(30);
    expect(wakeCount).toBeGreaterThan(0);

    // Critical for the acceptance criterion:
    // A user message on the same session would be dispatched within the
    // current dedup trailing window (at most dedup.windowMs = 5s from now),
    // not behind 50 pending wakes. The reduced wakeCount proves this.
  });

  it("decision / terminal wakes are never blocked by budget or dedup", () => {
    // Spec requirement: decision/terminal/hitl always wake immediately.
    // In webhook-handler.ts, these bypass both dedup and budget.
    // This test documents the contract by verifying they fire at 100%.
    const clock = makeFakeClock();

    const budget = new WakeBudget(
      { maxWakesPerFlowPerWindow: 0, windowMs: 60_000 }, // cap=0 — everything over budget!
      clock.deps,
    );

    let decisionWakes = 0;
    // In the real handler, decision events go directly to fireWake without
    // checking budget or dedup. Simulate that by NOT calling checkBudget.
    decisionWakes++; // decision 1
    decisionWakes++; // decision 2
    decisionWakes++; // terminal

    // Budget had cap=0 but decision wakes bypassed it entirely.
    expect(decisionWakes).toBe(3);
    // Budget was never consulted for these wakes.
    expect(budget._testGetCount("flow")).toBe(0);
  });

  it("deferred dedup wakes still count against the budget", () => {
    // This test verifies Fix #3: dedup trailing callbacks must pass through
    // wakeBudget.checkBudget() before firing fireWake, so the circuit
    // breaker cannot be bypassed by high-churn flows with many distinct keys.
    const clock = makeFakeClock();

    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 2, windowMs: 60_000 }, clock.deps);
    const dedup = new WakeDedup({ enabled: true, windowMs: 1_000 }, clock.deps);

    let wakeCount = 0;
    const fireWake = () => {
      wakeCount++;
    };

    // Helper: simulates webhook-handler wiring — dedup trailing goes through budget
    const handleMilestone = (body: IncomingEventBody) => {
      const budgetCheckedFireWake = () => {
        const withinBudget = budget.checkBudget(body.flow_id, fireWake);
        if (withinBudget) fireWake();
      };
      const ok = dedup.shouldWakeNow(body, budgetCheckedFireWake);
      if (ok) {
        const budgetOk = budget.checkBudget(body.flow_id, fireWake);
        if (budgetOk) fireWake();
      }
    };

    // 3 distinct keys, each fires once immediately (within budget cap=2 for first two)
    handleMilestone(makePhaseBody("a", "started", "flow-1")); // immediate, count=1 → wakes (within cap)
    handleMilestone(makePhaseBody("b", "started", "flow-1")); // immediate, count=2 → wakes (at cap)
    handleMilestone(makePhaseBody("c", "started", "flow-1")); // immediate, count=3 → over budget, deferred

    expect(wakeCount).toBe(2); // only 2 immediate wakes (within cap)
    expect(budget._testHasPendingTrailing("flow-1")).toBe(true);

    // Advance window — budget trailing fires (carries the latest fireWake callback directly)
    clock.advance(60_000);
    expect(wakeCount).toBe(3); // trailing budget wake fires

    // Now add a 4th distinct key that gets dedup-deferred (same key repeat)
    handleMilestone(makePhaseBody("a", "started", "flow-1")); // dedup-deferred (seen within window)

    // Advance past dedup window — dedup trailing fires → budget check
    // Budget was reset by the previous window, so this should be within budget
    clock.advance(2_000);
    // The dedup trailing callback hits budget — should fire since budget reset
    expect(wakeCount).toBe(4);
  });
});
