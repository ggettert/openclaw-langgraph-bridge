# multi-node-stub-graph

Minimal parallel-branch LangGraph graph for testing how the
`openclaw-langgraph-bridge` handles multi-node updates SSE frames.

## Graph Shape

```
START → fanout → branch_a ─┐
              └→ branch_b ─┤→ joinup → END
```

`fanout` fans out to two parallel branches (`branch_a`, `branch_b`). Both
converge at `joinup`, which emits `final = "joined:a,b"`.

The key property: LangGraph may emit both `branch_a` and `branch_b` deltas in
a **single `updates` SSE frame**. The integration test documents how many
`milestone` events the bridge actually emits in that case.

## Usage

This graph is registered alongside `integration-stub` and `hitl-stub` in the
combined `examples/integration-test-graph/langgraph.json`. Start all three
assistants from there:

```bash
cd examples/integration-test-graph
python3.11 -m venv .venv
.venv/bin/pip install "langgraph-cli[inmem]"
.venv/bin/langgraph dev --no-browser --port 2024
```

Then run the integration suite:

```bash
LANGGRAPH_BASE_URL=http://localhost:2024 \
LANGGRAPH_MULTI_NODE_WORKFLOW=multi-node-stub \
  npm run test:integration -- src/integration/multi-node-updates.integration.test.ts
```

Override the assistant id if you registered it under a different name:

```bash
LANGGRAPH_MULTI_NODE_WORKFLOW=<your-assistant-id> npm run test:integration \
  -- src/integration/multi-node-updates.integration.test.ts
```
