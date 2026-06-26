/**
 * Phase 2 (issue #91) — same-node milestone dedup + parallel-fanout collapse.
 *
 * Two dedup layers, both milestone-only. `decision` / `hitl` / `terminal`
 * events must NEVER pass through this module — they are always woken
 * immediately.
 *
 * ── Layer 1: same-key dedup window ──────────────────────────────────────
 *
 *   If a milestone with the same dedup key was emitted within
 *   `dedup.windowMs`, fold the subsequent occurrence into a single
 *   trailing-edge wake instead of firing immediately. The trailing wake
 *   carries the most-recent summary so narration advances.
 *
 *   Dedup key:
 *     - PhaseEventPayload (data has `phase` + `event` strings):
 *       key = `"${phase}:${event}"` — deterministic, already parsed.
 *     - Everything else: key = body.title (e.g. "node:coder").
 *
 * ── Layer 2: parallel-fanout collapse (topology-agnostic) ───────────────
 *
 *   When a milestone looks like a "finished" event, it may belong to a
 *   parallel-branch fanout superstep (e.g. two reviewer branches completing
 *   concurrently). The plugin has no graph topology knowledge, so detection
 *   is structural: if ≥2 distinct dedup keys both emit "finished" milestones
 *   within `dedup.windowMs` of each other, they are in the same fanout
 *   group and collapse to ONE trailing-edge wake.
 *
 *   "Finished" detection heuristic:
 *     - data.event equals "finished", "complete", "completed", or "done"
 *       (case-insensitive), OR
 *     - body.title ends with one of those suffixes (":finished", ":done", …).
 *   No node-name strings appear in this file — detection is purely structural.
 *
 *   All "finished" milestones are deferred (never fire immediately) so that
 *   concurrent branches arriving within the window can be batched. This
 *   adds up to `windowMs` latency to finished-event narration, which is
 *   acceptable and invisible to end users for typical workflow timings.
 *
 * Time is injected via `WakeDedupTimeDeps` for deterministic testing.
 */

import type { IncomingEventBody } from "./webhook-handler.js";

export type WakeDedupConfig = {
  /**
   * Enable milestone dedup. Default: `true`.
   * Set to `false` to restore pre-#91 behaviour (every milestone wakes).
   */
  enabled: boolean;
  /**
   * Dedup/fanout window in milliseconds. Default: 5000.
   * Same-key repeats within this window fold to one trailing wake.
   * Concurrent "finished" keys within this window collapse to one fanout wake.
   */
  windowMs: number;
};

export type WakeDedupTimeDeps = {
  /** Override for `Date.now()`. Inject a fake for deterministic tests. */
  now?: () => number;
  /**
   * Override for `setTimeout`. Must have the same signature as the global.
   */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /**
   * Override for `clearTimeout`. Must have the same signature as the global.
   */
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
};

type KeyEntry = {
  /** When this key was first seen (epoch ms). */
  firstSeenAt: number;
  /** Pending same-key trailing timer, or null. */
  trailingHandle: ReturnType<typeof setTimeout> | null;
  /** Latest wake callback (updated on every same-key repeat). */
  trailingCallback: (() => void) | null;
};

type FanoutGroup = {
  /** When the first "finished" key in this group was seen. */
  windowStart: number;
  /** All distinct "finished" keys seen so far in this group. */
  keys: Set<string>;
  /** Pending fanout coalesce timer. */
  timerHandle: ReturnType<typeof setTimeout> | null;
  /** Latest wake callback (updated as more keys join the group). */
  trailingCallback: (() => void) | null;
};

// ---------------------------------------------------------------------------
// Key extraction
// ---------------------------------------------------------------------------

/**
 * Extract the dedup key for a milestone body.
 *
 * Uses `(phase, event)` from data when the payload is a PhaseEventPayload —
 * that's clean and deterministic. Falls back to `body.title` otherwise.
 * Never contains node-name hardcoding.
 */
export function getDedupKey(body: IncomingEventBody): string {
  const data = body.data as Record<string, unknown> | undefined;
  if (data != null && typeof data.phase === "string" && typeof data.event === "string") {
    return `${data.phase}:${data.event}`;
  }
  return body.title ?? `unknown:${body.flow_id}`;
}

/**
 * Detect whether a milestone body represents a "finished" / terminal-node
 * event. Purely structural: checks `data.event` and `title` suffixes with
 * no node-name references.
 */
export function isFinishedMilestone(body: IncomingEventBody): boolean {
  const data = body.data as Record<string, unknown> | undefined;
  if (data != null && typeof data.event === "string") {
    const ev = (data.event as string).toLowerCase();
    if (ev === "finished" || ev === "complete" || ev === "completed" || ev === "done") {
      return true;
    }
  }
  const title = (body.title ?? "").toLowerCase();
  return (
    title.endsWith(":finished") ||
    title.endsWith(":complete") ||
    title.endsWith(":completed") ||
    title.endsWith(":done")
  );
}

// ---------------------------------------------------------------------------
// WakeDedup state machine
// ---------------------------------------------------------------------------

/**
 * Plugin-side milestone deduplicator.
 *
 * One instance should be shared for the lifetime of the plugin (not
 * per-flow). The keyCache is global so the same-key dedup works across
 * concurrent flows without interference (keys are namespaced by title or
 * `phase:event`, which are flow-specific in practice).
 *
 * Thread-safety: not required (Node.js single-threaded event loop).
 */
export class WakeDedup {
  private readonly keyCache = new Map<string, KeyEntry>();
  private activeFanout: FanoutGroup | null = null;
  private readonly config: WakeDedupConfig;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(config: WakeDedupConfig, deps: WakeDedupTimeDeps = {}) {
    this.config = config;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimer = deps.clearTimer ?? globalThis.clearTimeout.bind(globalThis);
  }

  /**
   * Determine whether a milestone wake should fire immediately.
   *
   * @param body - The IncomingEventBody for the milestone.
   * @param onTrailingWake - Callback invoked when the deferred trailing-edge
   *   wake fires. The callback closes over the current wake message and
   *   session info. On same-key repeats or fanout grouping, the latest
   *   callback replaces the prior one so the most-recent summary is used.
   * @returns `true` if the wake should fire immediately; `false` if the
   *   wake has been deferred to a trailing edge.
   */
  shouldWakeNow(body: IncomingEventBody, onTrailingWake: () => void): boolean {
    if (!this.config.enabled) {
      return true; // dedup disabled: always wake immediately
    }

    const key = getDedupKey(body);
    const now = this.now();

    // ── Layer 1: same-key dedup ──────────────────────────────────────────
    const existing = this.keyCache.get(key);
    if (existing != null && now - existing.firstSeenAt < this.config.windowMs) {
      // Repeat within window: update callback and schedule trailing edge.
      existing.trailingCallback = onTrailingWake;
      if (existing.trailingHandle == null) {
        const remaining = this.config.windowMs - (now - existing.firstSeenAt);
        existing.trailingHandle = this.setTimer(
          () => {
            const e = this.keyCache.get(key);
            if (e?.trailingCallback != null) {
              const cb = e.trailingCallback;
              e.trailingHandle = null;
              e.trailingCallback = null;
              e.firstSeenAt = this.now(); // reset for next occurrence
              cb();
            }
          },
          Math.max(0, remaining),
        );
      }
      return false; // suppressed — trailing edge pending
    }

    // New key or expired window: register / refresh.
    if (existing?.trailingHandle != null) {
      this.clearTimer(existing.trailingHandle);
    }
    this.keyCache.set(key, { firstSeenAt: now, trailingHandle: null, trailingCallback: null });

    // ── Layer 2: parallel-fanout collapse ────────────────────────────────
    // All "finished" milestones are deferred into a fanout group rather
    // than firing immediately. This ensures that concurrent branch
    // completions (e.g. two reviewer agents finishing within the window)
    // collapse into one wake rather than two.
    if (isFinishedMilestone(body)) {
      return this.handleFinished(key, now, onTrailingWake);
    }

    // Non-finished, new key: wake immediately.
    return true;
  }

  private handleFinished(key: string, now: number, onTrailingWake: () => void): boolean {
    // Check if there is an active fanout group whose window has not expired.
    if (this.activeFanout != null && now - this.activeFanout.windowStart < this.config.windowMs) {
      // Join the existing group: add key, update callback to latest.
      this.activeFanout.keys.add(key);
      this.activeFanout.trailingCallback = onTrailingWake;
      // The trailing timer was already scheduled for this group; no action needed.
      return false; // defer to group trailing edge
    }

    // Start a new fanout group for this "finished" event.
    if (this.activeFanout?.timerHandle != null) {
      this.clearTimer(this.activeFanout.timerHandle);
    }

    const group: FanoutGroup = {
      windowStart: now,
      keys: new Set([key]),
      timerHandle: null,
      trailingCallback: onTrailingWake,
    };

    group.timerHandle = this.setTimer(() => {
      // Only fire if this group is still the active one (not replaced by a
      // subsequent group that started after the window expired).
      if (this.activeFanout === group) {
        const cb = group.trailingCallback;
        group.timerHandle = null;
        group.trailingCallback = null;
        this.activeFanout = null;
        cb?.();
      }
    }, this.config.windowMs);

    this.activeFanout = group;
    return false; // always defer "finished" events
  }

  // ---------------------------------------------------------------------------
  // Test-only introspection
  // ---------------------------------------------------------------------------

  /**
   * @internal — tests only. Returns the number of keys in the active fanout
   * group, or 0 if no group is active.
   */
  _testActiveFanoutSize(): number {
    return this.activeFanout?.keys.size ?? 0;
  }

  /**
   * @internal — tests only. Returns true when a trailing timer is pending
   * for the given dedup key.
   */
  _testHasPendingTrailingForKey(key: string): boolean {
    return this.keyCache.get(key)?.trailingHandle != null;
  }

  /**
   * @internal — tests only. Returns whether a fanout group is currently
   * active.
   */
  _testHasActiveFanout(): boolean {
    return this.activeFanout != null;
  }
}
