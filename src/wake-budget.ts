/**
 * Phase 1 (issue #91) — per-flow wake budget (circuit breaker).
 *
 * Tracks how many agent wakes have been issued for each `flow_id` within
 * a rolling window. When the cap is reached, subsequent wakes are NOT
 * dropped — they are coalesced into a single **trailing-edge** wake that
 * fires at the end of the current window, carrying the latest milestone
 * summary so narration continues to advance.
 *
 * Contract:
 *  - `decision` / `hitl` / `terminal` events must NEVER pass through
 *    this module. Only `milestone` (wake-light) frames are subject to
 *    the budget.
 *  - Call `pruneFlow(flowId)` on every `terminal` event so the per-flow
 *    map doesn't grow forever and any pending trailing-edge timer is
 *    cancelled.
 *
 * Time is injected via `WakeBudgetTimeDeps` for deterministic testing.
 */

export type WakeBudgetConfig = {
  /**
   * Maximum agent wakes issued for one flow_id within `windowMs`.
   * Default: 15. Once exceeded, further wakes in the same window are
   * coalesced into a single trailing-edge wake.
   */
  maxWakesPerFlowPerWindow: number;
  /**
   * Rolling window size in milliseconds. Default: 60 000 (1 minute).
   */
  windowMs: number;
};

export type WakeBudgetTimeDeps = {
  /** Override for `Date.now()`. Inject a fake for deterministic tests. */
  now?: () => number;
  /**
   * Override for `setTimeout`. Must have the same signature as the
   * global. Inject a fake for deterministic tests.
   */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /**
   * Override for `clearTimeout`. Must have the same signature as the
   * global. Inject a fake for deterministic tests.
   */
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
};

type FlowEntry = {
  /** Start of the current window (epoch ms). */
  windowStart: number;
  /** Number of wakes issued in the current window. */
  count: number;
  /** Pending trailing-edge timer handle, or null if not scheduled. */
  trailingHandle: ReturnType<typeof setTimeout> | null;
  /**
   * Latest trailing-edge callback. Updated on every over-budget call so
   * the most-recent wake data is carried at fire time.
   */
  trailingCallback: (() => void) | null;
};

/**
 * Per-flow sliding-window wake budget.
 *
 * Thread-safety: not required (Node.js single-threaded event loop).
 */
export class WakeBudget {
  private readonly flows = new Map<string, FlowEntry>();
  private readonly config: WakeBudgetConfig;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(config: WakeBudgetConfig, deps: WakeBudgetTimeDeps = {}) {
    this.config = config;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimer = deps.clearTimer ?? globalThis.clearTimeout.bind(globalThis);
  }

  /**
   * Check whether a wake is within budget for `flowId`.
   *
   * @param flowId - The flow_id whose budget to check.
   * @param onTrailingWake - Zero-argument callback that performs the
   *   actual wake when the trailing-edge timer fires. The callback closes
   *   over the current wake arguments; it is replaced on every call so
   *   the trailing wake always carries the **latest** summary.
   * @returns `true` → wake immediately; `false` → over budget (a
   *   trailing-edge wake has been scheduled or updated).
   */
  checkBudget(flowId: string, onTrailingWake: () => void): boolean {
    const now = this.now();
    let entry = this.flows.get(flowId);

    // Roll window: expired or first call for this flow.
    if (entry == null || now - entry.windowStart >= this.config.windowMs) {
      if (entry?.trailingHandle != null) {
        this.clearTimer(entry.trailingHandle);
      }
      entry = { windowStart: now, count: 0, trailingHandle: null, trailingCallback: null };
      this.flows.set(flowId, entry);
    }

    // Always update trailing callback with the latest wake closure.
    entry.trailingCallback = onTrailingWake;

    if (entry.count < this.config.maxWakesPerFlowPerWindow) {
      entry.count++;
      return true; // within budget — fire immediately
    }

    // Over budget: schedule (or keep) a trailing-edge wake at window end.
    if (entry.trailingHandle == null) {
      const remaining = this.config.windowMs - (now - entry.windowStart);
      entry.trailingHandle = this.setTimer(
        () => {
          const e = this.flows.get(flowId);
          if (e?.trailingCallback != null) {
            const cb = e.trailingCallback;
            // Reset for the next window.
            e.trailingHandle = null;
            e.trailingCallback = null;
            e.count = 0;
            e.windowStart = this.now();
            cb();
          }
        },
        Math.max(0, remaining),
      );
    }
    // else: trailing already pending; latestCallback already updated above.

    return false; // over budget — trailing edge pending
  }

  /**
   * Prune a flow's budget state and cancel any pending trailing-edge wake.
   *
   * Must be called on every `terminal` event for the flow so:
   *  1. The per-flow map entry is removed (GC).
   *  2. A spurious trailing-edge wake is not fired after the flow ends.
   */
  pruneFlow(flowId: string): void {
    const entry = this.flows.get(flowId);
    if (entry?.trailingHandle != null) {
      this.clearTimer(entry.trailingHandle);
    }
    this.flows.delete(flowId);
  }

  // ---------------------------------------------------------------------------
  // Test-only introspection
  // ---------------------------------------------------------------------------

  /**
   * @internal — tests only. Returns wake count in the current window.
   */
  _testGetCount(flowId: string): number {
    return this.flows.get(flowId)?.count ?? 0;
  }

  /**
   * @internal — tests only. Returns true when a trailing timer is pending.
   */
  _testHasPendingTrailing(flowId: string): boolean {
    return this.flows.get(flowId)?.trailingHandle != null;
  }
}
