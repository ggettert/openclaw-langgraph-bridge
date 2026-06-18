import { describe, expect, it } from "vitest";
import {
  enqueueWake,
  _testQueueDepth,
  _testIsDraining,
} from "./wake-queue.js";

// ---------------------------------------------------------------------------
// Deferred-promise helper — gives tests explicit control over when each
// wake "subprocess" resolves.
// ---------------------------------------------------------------------------

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush all pending microtasks / promise callbacks. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Basic FIFO ordering
// ---------------------------------------------------------------------------

describe("enqueueWake — FIFO ordering, same sessionKey", () => {
  it("executes jobs in emission order regardless of resolution timing", async () => {
    const sessionKey = `test:fifo:${Math.random()}`;
    const order: number[] = [];

    const d1 = deferred();
    const d2 = deferred();
    const d3 = deferred();

    // Enqueue 3 jobs. Job 2 will be resolved before job 1 to verify that
    // the queue doesn't reorder based on resolution speed.
    enqueueWake(sessionKey, () => {
      return d1.promise.then(() => {
        order.push(1);
      });
    });
    enqueueWake(sessionKey, () => {
      return d2.promise.then(() => {
        order.push(2);
      });
    });
    enqueueWake(sessionKey, () => {
      return d3.promise.then(() => {
        order.push(3);
      });
    });

    // After enqueue, drain has started and is awaiting job 1.
    // Jobs 2 and 3 are still in the queue.
    await flushMicrotasks();
    expect(_testQueueDepth(sessionKey)).toBe(2); // jobs 2+3 pending
    expect(_testIsDraining(sessionKey)).toBe(true);
    expect(order).toEqual([]); // nothing completed yet

    // Resolve job 1 first — drain picks up job 2 next.
    d1.resolve();
    await flushMicrotasks();
    expect(order).toEqual([1]);

    // Resolve job 2 — drain picks up job 3.
    d2.resolve();
    await flushMicrotasks();
    expect(order).toEqual([1, 2]);

    // Resolve job 3 — drain exits.
    d3.resolve();
    await flushMicrotasks();
    expect(order).toEqual([1, 2, 3]);
    expect(_testIsDraining(sessionKey)).toBe(false);
    expect(_testQueueDepth(sessionKey)).toBe(0);
  });

  it("staggered resolution does NOT reorder: slower job 1 doesn't let job 2 jump ahead", async () => {
    const sessionKey = `test:staggered:${Math.random()}`;
    const calls: string[] = [];

    const d1 = deferred();
    const d2 = deferred();

    enqueueWake(sessionKey, () => d1.promise.then(() => { calls.push("job1"); }));
    enqueueWake(sessionKey, () => d2.promise.then(() => { calls.push("job2"); }));

    await flushMicrotasks();
    // Job 2's deferred is resolved first — but it can't start until job 1 finishes.
    d2.resolve();
    await flushMicrotasks();
    expect(calls).toEqual([]); // job 1 still in flight

    d1.resolve();
    await flushMicrotasks();
    expect(calls).toEqual(["job1", "job2"]); // correct order
  });
});

// ---------------------------------------------------------------------------
// Independent keys — no cross-blocking
// ---------------------------------------------------------------------------

describe("enqueueWake — different sessionKeys do not block each other", () => {
  it("jobs on keyA and keyB run concurrently", async () => {
    const keyA = `test:keyA:${Math.random()}`;
    const keyB = `test:keyB:${Math.random()}`;
    const calls: string[] = [];

    const dA = deferred();
    const dB = deferred();

    enqueueWake(keyA, () => dA.promise.then(() => { calls.push("A"); }));
    enqueueWake(keyB, () => dB.promise.then(() => { calls.push("B"); }));

    await flushMicrotasks();
    // Both drains are active simultaneously.
    expect(_testIsDraining(keyA)).toBe(true);
    expect(_testIsDraining(keyB)).toBe(true);

    // Resolve B first — should complete immediately, A still pending.
    dB.resolve();
    await flushMicrotasks();
    expect(calls).toEqual(["B"]);
    expect(_testIsDraining(keyA)).toBe(true);

    dA.resolve();
    await flushMicrotasks();
    expect(calls).toEqual(["B", "A"]);
    expect(_testIsDraining(keyA)).toBe(false);
    expect(_testIsDraining(keyB)).toBe(false);
  });

  it("a stalled queue on keyA does not delay delivery on keyB", async () => {
    const keyA = `test:stallA:${Math.random()}`;
    const keyB = `test:stallB:${Math.random()}`;
    const calls: string[] = [];

    const dA = deferred(); // never resolved in this test
    const dB = deferred();

    enqueueWake(keyA, () => dA.promise.then(() => { calls.push("A"); }));
    enqueueWake(keyB, () => dB.promise.then(() => { calls.push("B"); }));

    await flushMicrotasks();
    dB.resolve();
    await flushMicrotasks();
    // B completed even though A is still in-flight.
    expect(calls).toEqual(["B"]);
    expect(_testIsDraining(keyA)).toBe(true); // A still running

    // Cleanup: resolve A so the queue doesn't leak between tests.
    dA.resolve();
    await flushMicrotasks();
  });
});

// ---------------------------------------------------------------------------
// Error handling — failed job does not stall queue
// ---------------------------------------------------------------------------

describe("enqueueWake — error in run does not stall drain", () => {
  it("job that rejects is caught; subsequent job still runs", async () => {
    const sessionKey = `test:err:${Math.random()}`;
    const calls: string[] = [];

    const dBad = deferred();
    const dGood = deferred();

    enqueueWake(sessionKey, () => dBad.promise); // will reject
    enqueueWake(sessionKey, () =>
      dGood.promise.then(() => { calls.push("good"); }),
    );

    await flushMicrotasks();
    // Reject job 1.
    dBad.reject(new Error("subprocess crashed"));
    await flushMicrotasks();
    // Job 2 should now be running.
    dGood.resolve();
    await flushMicrotasks();
    expect(calls).toEqual(["good"]);
    expect(_testIsDraining(sessionKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Late-arriving jobs are picked up by existing drain loop
// ---------------------------------------------------------------------------

describe("enqueueWake — late-arriving jobs join in-flight drain", () => {
  it("a job enqueued while drain is running is still executed", async () => {
    const sessionKey = `test:late:${Math.random()}`;
    const calls: string[] = [];

    const d1 = deferred();
    const d2 = deferred();

    enqueueWake(sessionKey, () => d1.promise.then(() => { calls.push("first"); }));
    await flushMicrotasks();
    expect(_testIsDraining(sessionKey)).toBe(true);

    // Enqueue while drain is awaiting d1.
    enqueueWake(sessionKey, () => d2.promise.then(() => { calls.push("second"); }));
    expect(_testQueueDepth(sessionKey)).toBe(1); // queued, drain not restarted

    d1.resolve();
    await flushMicrotasks();
    expect(calls).toEqual(["first"]);
    // Drain should now be processing d2.
    d2.resolve();
    await flushMicrotasks();
    expect(calls).toEqual(["first", "second"]);
    expect(_testIsDraining(sessionKey)).toBe(false);
  });
});
