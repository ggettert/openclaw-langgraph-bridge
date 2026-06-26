/**
 * Tests for WakeBudget (issue #91, Phase 1).
 *
 * Time is injected via the WakeBudgetTimeDeps so these tests run
 * deterministically without real timers.
 */

import { describe, expect, it, vi } from "vitest";
import { WakeBudget } from "./wake-budget.js";

// ---------------------------------------------------------------------------
// Test-clock helpers
// ---------------------------------------------------------------------------

type FakeTimer = {
  /** Current fake time (ms). */
  now: () => number;
  /** Advance time by `ms` and fire any timers that are now due. */
  advance: (ms: number) => void;
  /** deps object to pass to WakeBudget constructor. */
  deps: ConstructorParameters<typeof WakeBudget>[1];
};

function makeFakeClock(initialMs = 0): FakeTimer {
  let currentMs = initialMs;
  type Entry = { fn: () => void; fireAt: number };
  const timers: Entry[] = [];
  let nextHandle = 1;
  // Map handle → entry for clearTimeout support
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
    // Fire all timers whose fireAt <= currentMs (in order).
    let fired = true;
    while (fired) {
      fired = false;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i]!;
        if (t.fireAt <= currentMs) {
          timers.splice(i, 1);
          fired = true;
          t.fn();
          break; // restart scan (fn may enqueue new timers)
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
// Suite 1: within-budget behavior
// ---------------------------------------------------------------------------

describe("WakeBudget — within-cap wakes fire immediately", () => {
  it("returns true for the first wake (count=1 of cap=3)", () => {
    const clock = makeFakeClock();
    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 3, windowMs: 10_000 }, clock.deps);

    const cb = vi.fn();
    expect(budget.checkBudget("flow-1", cb)).toBe(true);
    expect(budget._testGetCount("flow-1")).toBe(1);
    expect(cb).not.toHaveBeenCalled();
  });

  it("returns true for each of the first cap wakes", () => {
    const clock = makeFakeClock();
    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 5, windowMs: 10_000 }, clock.deps);
    for (let i = 0; i < 5; i++) {
      expect(budget.checkBudget("f", vi.fn()), `wake ${i + 1}`).toBe(true);
    }
    expect(budget._testGetCount("f")).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: cap + trailing coalesce
// ---------------------------------------------------------------------------

describe("WakeBudget — cap + trailing-edge coalesce", () => {
  it("returns false on the (cap+1)th wake and schedules a trailing timer", () => {
    const clock = makeFakeClock();
    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 2, windowMs: 10_000 }, clock.deps);

    budget.checkBudget("flow", vi.fn()); // 1 — within budget
    budget.checkBudget("flow", vi.fn()); // 2 — within budget

    const trailing = vi.fn();
    const result = budget.checkBudget("flow", trailing); // 3 — over budget
    expect(result).toBe(false);
    expect(budget._testHasPendingTrailing("flow")).toBe(true);
    expect(trailing).not.toHaveBeenCalled();
  });

  it("trailing-edge wake fires exactly once at window end", () => {
    const clock = makeFakeClock();
    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 2, windowMs: 10_000 }, clock.deps);

    budget.checkBudget("flow", vi.fn());
    budget.checkBudget("flow", vi.fn());

    const trailing = vi.fn();
    budget.checkBudget("flow", trailing); // cap exceeded

    // Before window ends: not fired
    clock.advance(5_000);
    expect(trailing).not.toHaveBeenCalled();

    // At/after window end: fired once
    clock.advance(5_000);
    expect(trailing).toHaveBeenCalledOnce();
  });

  it("subsequent over-budget calls update the trailing callback (latest wins)", () => {
    const clock = makeFakeClock();
    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 1, windowMs: 10_000 }, clock.deps);

    budget.checkBudget("flow", vi.fn()); // cap hit (count=1)

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();
    budget.checkBudget("flow", cb1);
    budget.checkBudget("flow", cb2);
    budget.checkBudget("flow", cb3);

    clock.advance(10_000);

    // Only the latest callback fires
    expect(cb3).toHaveBeenCalledOnce();
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it("only one trailing timer is scheduled even if many over-budget calls arrive", () => {
    const clock = makeFakeClock();
    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 1, windowMs: 10_000 }, clock.deps);

    budget.checkBudget("flow", vi.fn()); // cap hit

    const cbs = Array.from({ length: 5 }, () => vi.fn());
    for (const cb of cbs) budget.checkBudget("flow", cb);

    // Exactly one trailing timer pending
    expect(budget._testHasPendingTrailing("flow")).toBe(true);

    clock.advance(10_000);
    // Exactly the last callback fires
    expect(cbs[cbs.length - 1]).toHaveBeenCalledOnce();
    const fired = cbs.filter((cb) => cb.mock.calls.length > 0);
    expect(fired).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: window reset after trailing edge fires
// ---------------------------------------------------------------------------

describe("WakeBudget — counter resets after window expires", () => {
  it("after the trailing-edge fires, budget resets and next cap wakes fire immediately", () => {
    const clock = makeFakeClock();
    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 2, windowMs: 10_000 }, clock.deps);

    budget.checkBudget("flow", vi.fn());
    budget.checkBudget("flow", vi.fn());

    const trailing = vi.fn();
    budget.checkBudget("flow", trailing); // over budget
    clock.advance(10_000); // trailing fires, window resets

    expect(trailing).toHaveBeenCalledOnce();
    expect(budget._testGetCount("flow")).toBe(0);

    // New window: next two wakes are within budget
    expect(budget.checkBudget("flow", vi.fn())).toBe(true);
    expect(budget.checkBudget("flow", vi.fn())).toBe(true);
    expect(budget._testGetCount("flow")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: pruneFlow (terminal GC)
// ---------------------------------------------------------------------------

describe("WakeBudget — pruneFlow cancels pending trailing-edge", () => {
  it("pruneFlow on a flow with a pending trailing timer cancels it", () => {
    const clock = makeFakeClock();
    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 1, windowMs: 10_000 }, clock.deps);

    budget.checkBudget("flow", vi.fn()); // cap hit
    const trailing = vi.fn();
    budget.checkBudget("flow", trailing); // over budget, timer scheduled

    budget.pruneFlow("flow");
    expect(budget._testHasPendingTrailing("flow")).toBe(false);

    clock.advance(10_000);
    expect(trailing).not.toHaveBeenCalled(); // timer was cancelled
  });

  it("pruneFlow on a flow with no entry is a no-op", () => {
    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 5, windowMs: 10_000 });
    expect(() => budget.pruneFlow("nonexistent")).not.toThrow();
  });

  it("pruneFlow removes the flow so the next event starts a fresh window", () => {
    const clock = makeFakeClock();
    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 2, windowMs: 10_000 }, clock.deps);

    budget.checkBudget("flow", vi.fn());
    budget.checkBudget("flow", vi.fn());
    budget.pruneFlow("flow");

    expect(budget._testGetCount("flow")).toBe(0);
    // Fresh window: first two wakes are within budget
    expect(budget.checkBudget("flow", vi.fn())).toBe(true);
    expect(budget.checkBudget("flow", vi.fn())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: independent flows don't interfere
// ---------------------------------------------------------------------------

describe("WakeBudget — independent flows", () => {
  it("exhausting budget for flow-A does not affect flow-B", () => {
    const clock = makeFakeClock();
    const budget = new WakeBudget({ maxWakesPerFlowPerWindow: 1, windowMs: 10_000 }, clock.deps);

    budget.checkBudget("flow-A", vi.fn()); // flow-A cap hit
    budget.checkBudget("flow-A", vi.fn()); // flow-A over budget

    // flow-B is independent — first wake within budget
    expect(budget.checkBudget("flow-B", vi.fn())).toBe(true);
    expect(budget._testGetCount("flow-B")).toBe(1);
  });
});
