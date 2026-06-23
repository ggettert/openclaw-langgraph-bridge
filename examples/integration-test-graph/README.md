# integration-test-graph

A minimal LangGraph project used exclusively by the **openclaw-langgraph-bridge integration test suite**.

## What it does

Registers a single assistant `integration-stub` backed by a trivial no-op graph:  
input → `passthrough` node → done. The graph returns no state updates and finishes immediately.

This is enough to satisfy `client.createRun()` and `dispatchAndStream()` without
requiring a real application graph or LangSmith account.

## Prerequisites

```bash
pip install "langgraph-cli[inmem]"
```

## Running locally

```bash
cd examples/integration-test-graph
langgraph dev --no-browser
# Server listens on http://localhost:2024 by default
```

Then, in another terminal:

```bash
# Verify the assistant registered correctly.
# GET /assistants/<id> requires a UUID literal; use POST /assistants/search to look up by graph_id.
curl -sf -X POST http://localhost:2024/assistants/search \
  -H 'content-type: application/json' \
  -d '{"graph_id":"integration-stub","limit":1}'

# Run the integration tests against it
LANGGRAPH_BASE_URL=http://localhost:2024 npm run test:integration
```

## CI

The `integration` job in `.github/workflows/ci.yml` starts this server automatically
before running `npm run test:integration`. See `.github/workflows/ci.yml` for details.

## Notes

- Do **not** add application logic here. Keep it as minimal as possible.
- The assistant id `integration-stub` is the default value of `LANGGRAPH_WORKFLOW`
  in `src/integration/helpers.ts`. Override with `LANGGRAPH_WORKFLOW=<id>` if you
  want to run integration tests against a different graph.
