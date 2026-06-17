/**
 * Phase 2 v3 live smoke for the streaming dispatch.
 *
 * Creates a thread, then dispatches a `fleet` run via dispatchAndStream.
 * Prints the run_id once captured, every classified event, and the
 * close reason. Exits when the stream closes.
 *
 * Run: npm run smoke:streaming
 *  or: node --import tsx scripts/smoke-streaming.ts
 */

import { dispatchAndStream } from "../src/event-subscriber.js";
import { LanggraphClient } from "../src/langgraph-client.js";

const BASE_URL = process.env.LANGGRAPH_BASE_URL ?? "http://langgraph.example.local:2024";
const WORKFLOW = process.env.LANGGRAPH_WORKFLOW ?? "fleet";

async function main() {
  console.log(`[smoke] target: ${BASE_URL}`);
  console.log(`[smoke] workflow: ${WORKFLOW}`);

  const client = new LanggraphClient({ baseUrl: BASE_URL, timeoutMs: 10_000 });
  const ok = await client.ok();
  if (!ok) throw new Error(`server at ${BASE_URL} not responsive`);
  console.log(`[smoke] /ok: ${ok}`);

  const threadId = await client.createThread({ smoke: "phase-2-v3-streaming" });
  console.log(`[smoke] thread_id: ${threadId}`);

  const done = new Promise<void>((resolve, reject) => {
    let runIdSeen = false;
    let eventCount = 0;

    const timer = setTimeout(() => {
      reject(new Error("[smoke] timed out waiting for stream to close"));
    }, 30_000);

    const controller = dispatchAndStream({
      baseUrl: BASE_URL,
      threadId,
      flowId: "smoke-no-flow",
      assistantId: WORKFLOW,
      input: { smoke: "phase-2-v3-streaming" },
      metadata: {
        openclaw_flow_id: "smoke-no-flow",
        openclaw_session_key: "smoke-session",
      },
      handlers: {
        onRunId: (runId) => {
          runIdSeen = true;
          console.log(`[smoke] onRunId: ${runId}`);
        },
        onEvent: (body) => {
          eventCount++;
          console.log(
            `[smoke] onEvent[${eventCount}]: kind=${body.kind} title=${body.title} summary=${(body.summary ?? "").slice(0, 100)}`,
          );
        },
        onError: (err) => {
          clearTimeout(timer);
          reject(new Error(`onError: ${err.message}`));
        },
        onClose: (sawTerminal) => {
          clearTimeout(timer);
          console.log(
            `[smoke] onClose: sawTerminal=${sawTerminal} runIdSeen=${runIdSeen} totalEvents=${eventCount}`,
          );
          resolve();
        },
      },
    });

    setTimeout(() => controller.abort(), 25_000);
  });

  await done;
  console.log("[smoke] ✅ phase-2-v3 streaming path works end-to-end");
}

main().catch((err: unknown) => {
  console.error(`[smoke] ❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
