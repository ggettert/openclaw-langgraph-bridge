/**
 * Per-sessionKey FIFO wake queue.
 *
 * Problem solved: when several SSE frames arrive in tight succession the
 * bridge was spawning one `openclaw agent` subprocess per event and
 * letting them race. Whichever subprocess finished its IPC handshake
 * first won the queue slot — short messages (e.g. the synthetic
 * `terminal:graph:end`) beat longer milestone messages and the human
 * saw "workflow ended" before seeing why.
 *
 * Fix: each call to `enqueueWake` pushes a job onto a per-sessionKey
 * queue and starts a drain loop if one isn't already running for that
 * key. The drain loop awaits each job's Promise in order — the next job
 * doesn't start until the previous subprocess exits. Different
 * sessionKeys (different Slack threads / DMs) each have an independent
 * queue and never block each other.
 *
 * Back-pressure: if a subprocess hangs, the queue for that sessionKey
 * stalls. That's the same blast-radius as today, and the existing
 * EXEC_BACKSTOP_PADDING_MS timeout in wake-agent.ts is the mitigation.
 */

type Job = { run: () => Promise<void> };

/** Keyed by sessionKey; each value is the pending-job FIFO for that key. */
const queues = new Map<string, Job[]>();

/** Set of sessionKeys for which a drain loop is currently active. */
const draining = new Set<string>();

/**
 * Enqueue a wake job for `sessionKey`. `run` must return a `Promise<void>`
 * that resolves (or rejects) when the wake subprocess has exited.
 *
 * Job rejections are caught here so a single failure does not stall the
 * queue, but the queue itself does NOT log them. Callers are expected to
 * do their own logging inside `run` (the default `wakeAgentAsync` path
 * does — see wake-agent.ts). A `run` that rejects silently will fail
 * silently from the queue's perspective.
 *
 * Jobs for the same `sessionKey` are executed in FIFO order. Jobs for
 * different keys execute concurrently (independent queues).
 */
export function enqueueWake(
  sessionKey: string,
  run: () => Promise<void>,
): void {
  const q = queues.get(sessionKey) ?? [];
  q.push({ run });
  queues.set(sessionKey, q);
  if (!draining.has(sessionKey)) {
    void drain(sessionKey);
  }
}

async function drain(sessionKey: string): Promise<void> {
  // Mark as draining synchronously before the first await so subsequent
  // enqueueWake calls see it and don't start a second drain loop.
  draining.add(sessionKey);
  try {
    while (true) {
      const q = queues.get(sessionKey);
      if (!q || q.length === 0) break;
      const job = q.shift()!;
      try {
        await job.run();
      } catch {
        // Swallow so we continue draining rather than leaving the queue
        // permanently stalled. We rely on `run` itself to surface errors
        // (the default wakeAgentAsync path logs via its injected logger).
      }
    }
  } finally {
    draining.delete(sessionKey);
    // GC: remove the empty queue entry so the Map doesn't grow unboundedly
    // over the lifetime of a long-running gateway process.
    const remaining = queues.get(sessionKey);
    if (!remaining || remaining.length === 0) {
      queues.delete(sessionKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Test-only introspection (not part of public API)
// ---------------------------------------------------------------------------

/**
 * @internal — exposed only for tests; do not call from production code.
 * Returns the number of pending (not-yet-started) jobs for a sessionKey.
 */
export function _testQueueDepth(sessionKey: string): number {
  return queues.get(sessionKey)?.length ?? 0;
}

/**
 * @internal — exposed only for tests.
 * Returns true if a drain loop is currently active for this sessionKey.
 */
export function _testIsDraining(sessionKey: string): boolean {
  return draining.has(sessionKey);
}
