# Direct LangGraph API Escape Hatch

Use direct HTTP calls when the plugin's managed view has diverged from truth and normal tool calls can't recover the situation.

## When to use

- Plugin flow status is stale (e.g. after gateway restart) and `langgraph_inspect` returns outdated state.
- `langgraph_resume` can't find the flow (record was lost with the gateway restart).
- You need to inspect raw thread state or run history that the plugin doesn't expose.

---

## Check thread state

```bash
curl -s http://localhost:2024/threads/<langgraph_thread_id>/state \
  | jq '{status: .status, next: .next, values_keys: (.values // {} | keys)}'
```

Replace `localhost:2024` with your `langgraphBaseUrl`. The `status` field will be the LangGraph thread's authoritative state (`idle`, `interrupted`, `busy`, `error`).

---

## Resume via direct API (when plugin resume fails)

```bash
curl -s -X POST http://localhost:2024/threads/<tid>/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "assistant_id": "<your-workflow>",
    "command": {"resume": {"decision": "approve", "feedback": ""}}
  }'
```

Adjust the `command.resume` object to match what your workflow's HITL gate expects.

---

## Post-direct-API caveats

After a direct-API resume, the plugin has **no SSE subscriber** on the new run. Post-resume events will not surface via the wake mechanism. You'll need to:

- Poll thread state manually with the `GET /threads/<tid>/state` call above, or
- Wait for the workflow's native webhook callback (if configured), or
- Re-dispatch the workflow entirely if the thread has reached a clean state and you want full wake coverage again.

The plugin's managed flow record will remain stale until the gateway restarts or the session expires. Avoid calling `langgraph_resume` through the plugin after a direct-API resume for the same thread — the plugin's state won't reflect the direct-API run.
