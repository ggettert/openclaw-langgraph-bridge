# Discovering and Using Unknown Workflows

## The principle

**Do not guess workflow input shapes from the workflow name.** LangGraph silently drops unknown keys at graph entry — it will accept a malformed input without error and only fail mid-run when a downstream node tries to read a key that was never set. You will see `KeyError: 'some_field'` in a terminal event, not a clean error at dispatch time.

The fix is simple: **inspect first**.

---

## The pattern

```
1. langgraph_list_workflows()              → confirm the workflow exists and is allowed
2. langgraph_inspect_workflow(workflow_id) → get the schemas
3. Read input_schema.required              → all mandatory fields
   Read input_schema.properties            → types of each field
4. langgraph_dispatch(workflow, input={…}) → build input from the schema, not from guesswork
```

You only need to inspect once per workflow per session. Skip steps 1–2 if you've already dispatched this workflow successfully in the current session and the schema is stable.

---

## When to skip introspection

- You dispatched this exact workflow successfully **in this session** and the shape is stable.
- You maintain an out-of-band schema reference (e.g. this skill file) that you trust and that matches the deployed workflow.

Do not call `langgraph_inspect_workflow` on every dispatch — once per session per workflow is enough.

---

## Worked example — inspecting before dispatching

**Step 1 — list to confirm the workflow exists:**

```python
result = langgraph_list_workflows()
# → find your workflow in result.workflows; check allowed: true
```

**Step 2 — inspect the schema:**

```python
result = langgraph_inspect_workflow(workflow_id="<my-workflow>")
```

Response:

```json
{
  "status": "ok",
  "workflow_id": "<my-workflow>",
  "schemas": {
    "input_schema": {
      "title": "WorkflowState",
      "type": "object",
      "properties": {
        "field_a": { "type": "string" },
        "field_b": { "type": "string" },
        "field_c": { "type": "string" }
      },
      "required": ["field_a", "field_b", "field_c"]
    },
    "output_schema": { "...": "..." },
    "state_schema":  { "...": "..." },
    "config_schema": { "...": "..." }
  }
}
```

**Step 3 — read the schema:**

- `input_schema.required` → every field listed here is mandatory.
- `input_schema.properties` → type of each field.

**Step 4 — dispatch with the correct input:**

```python
langgraph_dispatch(
    workflow="<my-workflow>",
    input={
        "field_a": "<value>",
        "field_b": "<value>",
        "field_c": "<value>"
    }
)
```

No keys will be silently dropped. No downstream node will `KeyError`.

---

## Error handling for inspect failures

If `langgraph_inspect_workflow` itself fails, **stop and resolve the error before dispatching**:

| `reason` | what happened | what to do |
|---|---|---|
| `workflow_not_found` | The workflow id doesn't exist on the LangGraph server | Double-check the id; verify the LangGraph server is running the expected workflow |
| `workflow_not_allowed` | The id is blocked by the `allowedWorkflows` allowlist | Use an allowed workflow id or update the config |
| `request_failed` | Network error, timeout, or server 5xx | Retry; if persistent, check LangGraph server health |

Do not fall back to guessing the schema if inspection fails — a blind dispatch will almost certainly `KeyError` mid-run.

---

See [examples/fleet-style-workflow.md](./examples/fleet-style-workflow.md) for a concrete worked example using the `fleet` workflow's specific schema.
