/**
 * Phase 1 live smoke test for the LangGraph client.
 *
 * Targets the dev server at the URL passed via env LANGGRAPH_BASE_URL
 * (default http://10.41.1.198:2024) and exercises:
 *   1. /ok       — liveness
 *   2. /info     — server metadata
 *   3. POST /threads      — create a thread
 *   4. POST /threads/{tid}/runs — start a run against the configured workflow
 *
 * Run:  node --import ./node_modules/tsx/dist/esm/index.mjs scripts/smoke-langgraph.ts
 *  or:  npm run smoke
 *
 * This script is not part of the plugin runtime — it just lets us validate
 * the wire protocol end-to-end without going through the OpenClaw gateway.
 */

import { LanggraphClient, LanggraphHttpError } from "../src/langgraph-client.js";

const BASE_URL = process.env.LANGGRAPH_BASE_URL ?? "http://10.41.1.198:2024";
const WORKFLOW = process.env.LANGGRAPH_WORKFLOW ?? "fleet";

async function main() {
  const client = new LanggraphClient({ baseUrl: BASE_URL, timeoutMs: 10_000 });

  console.log(`[smoke] target: ${BASE_URL}`);
  console.log(`[smoke] workflow: ${WORKFLOW}`);

  const ok = await client.ok();
  console.log(`[smoke] /ok: ${ok}`);
  if (!ok) {
    throw new Error(`server at ${BASE_URL} is not responsive`);
  }

  const info = await client.info();
  console.log(`[smoke] /info: ${JSON.stringify(info)}`);

  console.log(`[smoke] creating thread...`);
  const threadId = await client.createThread({
    openclaw_smoke: true,
    when: new Date().toISOString(),
  });
  console.log(`[smoke] thread_id: ${threadId}`);

  console.log(`[smoke] starting run on workflow ${WORKFLOW}...`);
  const run = await client.createRun(threadId, {
    assistantId: WORKFLOW,
    input: { smoke: "phase-1" },
    metadata: {
      openclaw_smoke: true,
      openclaw_flow_id: "smoke-no-flow",
    },
  });
  console.log(`[smoke] run_id: ${run.runId}`);
  console.log(`[smoke] ✅ phase-1 wire path works end-to-end`);
}

main().catch((err: unknown) => {
  if (err instanceof LanggraphHttpError) {
    console.error(
      `[smoke] ❌ LangGraph HTTP error ${err.status}: ${err.message}\nbody: ${err.body}`,
    );
  } else {
    console.error(`[smoke] ❌ ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
});
