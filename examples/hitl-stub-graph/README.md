# hitl-stub-graph

Minimal LangGraph example used by openclaw-langgraph-bridge integration tests
to exercise the HITL interrupt → resume → terminal lifecycle.

## What it does

Single node `gate` calls `interrupt({"prompt": "approve or block_revise?"})`.
Resume payload (any string or `{decision, feedback}` dict) routes to the
`done` node which sets:

- `final = "completed:<decision>"` — when no feedback is provided
- `final = "completed:<decision>:<feedback>"` — when feedback is present

Examples: `"completed:approve"`, `"completed:block_revise:cleanup the tests"`.

## Running locally

```bash
pip install "langgraph-cli[inmem]"
cd examples/hitl-stub-graph
langgraph dev --no-browser
# Server listens on http://localhost:2024 by default
```

Verify assistant registered:

```bash
curl -sf -X POST http://localhost:2024/assistants/search \
  -H 'content-type: application/json' \
  -d '{"graph_id":"hitl-stub","limit":1}'
```

Then run the integration suite with this graph as the workflow:

```bash
LANGGRAPH_BASE_URL=http://localhost:2024 LANGGRAPH_HITL_WORKFLOW=hitl-stub \
  npm run test:integration -- src/integration/hitl.integration.test.ts
```

Note: GET /assistants/<id> requires a UUID literal; use POST /assistants/search
to look up by graph_id. (Same pattern as the integration-stub example.)
