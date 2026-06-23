# Tool Reference — langgraph-bridge

Full parameter tables and return shapes for all five tools. Loaded on demand.

---

## `langgraph_dispatch`

Dispatch a new workflow run. Returns synchronously once LangGraph has accepted the run and returned a `run_id` (first SSE metadata frame). Event callbacks proceed asynchronously on the SSE stream.

**Parameters**

| param | type | required | notes |
|---|---|---|---|
| `workflow` | string | ✓ | LangGraph assistant UUID or graph id (e.g. `"my-workflow"`) |
| `input` | object | ✓ | Must match the workflow's state schema exactly — see schema warning below |
| `decision_only` | boolean | — | Default `true`. When `true`, only decision/HITL/terminal events wake the agent; milestone events update flow state silently. Status events never wake regardless. Set `false` to also wake on milestones. |

> **⚠ Schema enforcement.** LangGraph silently drops unknown keys in `input`. If your input has the wrong shape, downstream nodes will raise `KeyError` when they read a field they expect. You will NOT get a clear error at dispatch — you'll get a mid-run failure event. Use `langgraph_inspect_workflow` to read the exact schema before dispatching.

**Worked example**

```python
# Step 1: inspect to learn required fields
result = langgraph_inspect_workflow(workflow_id="my-workflow")
# → read result.schemas.input_schema.required

# Step 2: dispatch with the correct, complete input
result = langgraph_dispatch(
    workflow="my-workflow",
    input={
        "field_a": "<value>",
        "field_b": "<value>",
        # exact fields from input_schema.required
    }
)
# {
#   "status": "accepted",
#   "flow_id": "flow_abc123",
#   "langgraph_thread_id": "tid_...",
#   "langgraph_run_id": "run_...",
#   "workflow": "my-workflow",
#   "session_key": "agent:main:slack:channel:c01...:thread:1781..."
# }

# Step 3: yield — you will be woken when events fire
sessions_yield(message="Dispatched workflow run. Will report back on events.")
```

**What breaks if input is wrong**

```python
# ❌ WRONG — unknown keys silently dropped; downstream node KeyErrors
langgraph_dispatch(
    workflow="my-workflow",
    input={
        "unexpected_key": "value",    # ← dropped silently
        "another_wrong_key": "value",  # ← dropped silently
        # required fields missing entirely
    }
)
# Dispatch succeeds; workflow starts; downstream node crashes with KeyError mid-run.
```

See [discovering-workflows.md](./discovering-workflows.md) for the full inspect-first pattern.  
See [examples/fleet-style-workflow.md](./examples/fleet-style-workflow.md) for a fleet-specific dispatch example.

---

## `langgraph_inspect_workflow`

Fetch the JSON-Schema definitions a workflow expects as input, output, state, and config. Call this **before dispatching any workflow whose input shape you don't already know**.

**Parameters**

| param | type | required | notes |
|---|---|---|---|
| `workflow_id` | string | ✓ | LangGraph assistant UUID or graph id. Must match an assistant registered on the LangGraph server |

**Returns** (on success)

```json
{
  "status": "ok",
  "workflow_id": "<your-workflow>",
  "schemas": {
    "input_schema": { "title": "...", "type": "object", "properties": { ... }, "required": [ ... ] },
    "output_schema": { ... },
    "state_schema": { ... },
    "config_schema": { ... }
  }
}
```

Key surface: `schemas.input_schema`. Read `properties` for available fields, `required` for mandatory ones. Construct `langgraph_dispatch` input from these — do not guess.

**When to use**

- Any time you encounter a workflow not dispatched before in this session.
- Any time the workflow's input schema may have changed.
- Skip only if you dispatched this exact workflow successfully earlier in this session and the schema is stable.

**Allowlist enforcement**

If `allowedWorkflows` is configured and the `workflow_id` is not in it, the tool returns an error immediately — no LangGraph call is made:

```json
{ "status": "error", "reason": "workflow_not_allowed", "workflow_id": "..." }
```

**Error reasons**

| reason | meaning | action |
|---|---|---|
| `workflow_not_allowed` | `workflow_id` not in configured allowlist | Check `allowedWorkflows` config; use an allowed id |
| `workflow_not_found` | LangGraph server returned 404 | Verify the workflow id and confirm the server is running |
| `request_failed` | Network error, timeout, or server 5xx | Retry; if persistent, check LangGraph server health |
| `missing_langgraph_base_url` | Plugin misconfigured | Set `langgraphBaseUrl` in plugin config |

---

## `langgraph_list_workflows`

List every workflow (assistant) available on the configured LangGraph server.

**Parameters**

*No parameters.*

**Returns** (on success)

```json
{
  "status": "ok",
  "allowlist_active": true,
  "workflows": [
    {
      "assistant_id": "6d5d4365-62fd-59e2-807b-539d8f85d26e",
      "graph_id": "my-workflow",
      "name": "My Workflow",
      "description": "Runs the my-workflow orchestration pipeline",
      "allowed": true
    },
    {
      "assistant_id": "aabbccdd-0000-1111-2222-333344445555",
      "graph_id": "triage",
      "name": "Triage Agent",
      "description": null,
      "allowed": false
    }
  ]
}
```

Key fields:
- `workflows[].allowed` — `false` means dispatching or inspecting will fail with `workflow_not_allowed`.
- `allowlist_active` — `true` when `allowedWorkflows` config is set and non-empty; when `false`, all workflows are effectively allowed.

**Pattern**: list workflows → pick the right `graph_id` or `assistant_id` → `langgraph_inspect_workflow` to learn input shape → `langgraph_dispatch` with correct input.

**Error reasons**

| reason | meaning | action |
|---|---|---|
| `request_failed` | Network error, timeout, or server 5xx | Retry; if persistent, check LangGraph server health |
| `missing_langgraph_base_url` | Plugin misconfigured | Set `langgraphBaseUrl` in plugin config |

---

## `langgraph_inspect`

Read the current state of a flow this session owns. Returns status, step, and flow metadata from the plugin's managed TaskFlow record.

**Parameters**

| param | type | notes |
|---|---|---|
| `flow_id` | string (optional) | Specific flow to inspect. Omit to inspect the latest flow in this session |

**Use after a wake** to confirm current status before acting:

```python
state = langgraph_inspect()
# state.inspect contains:
#   flow_id, status (queued/running/waiting/succeeded/failed/cancelled/lost),
#   currentStep, workflow, langgraph_thread_id, langgraph_run_id, ...
```

**Known issue — stale status after gateway restart**

Plugin managed TaskFlow state lives in process memory. A gateway restart wipes it. The plugin's view and LangGraph's view may diverge — e.g. plugin reports `"running"` while LangGraph is at a HITL interrupt or already completed.

When status looks wrong, use the direct LangGraph API to check truth. See [escape-hatch.md](./escape-hatch.md).

---

## `langgraph_resume`

Resume a workflow paused at a HITL interrupt. Opens a fresh SSE subscriber on the resumed run so all post-resume events (milestones, further HITL gates, terminal) surface in this session (Phase 5, v0.10.0+).

**Parameters**

| param | type | notes |
|---|---|---|
| `payload` | any | The human's reply. A plain string is usually correct. See normalization rules below |
| `flow_id` | string (optional) | Specific flow to resume. Omit to resume the latest waiting flow in this session |

**Payload normalization** — the plugin normalizes common HITL string replies into the structured shape `{decision, feedback}` that most workflow gate parsers expect:

| raw string | normalized |
|---|---|
| `"approve"`, `"yes"`, `"ok"`, `"lgtm"`, `"approved"` | `{decision: "approve", feedback: ""}` |
| `"block"`, `"block_revise"`, `"revise"`, `"no"` | `{decision: "block_revise", feedback: ""}` |
| `"block_revise: <text>"` or `"block: <text>"` | `{decision: "block_revise", feedback: "<text>"}` |
| `"abort"`, `"stop"`, `"cancel"`, `"block_abort"` | `{decision: "block_abort", feedback: ""}` |
| `"extend"`, `"extend_cap"`, `"continue"` | `{decision: "extend", feedback: ""}` |
| anything else / object | passed through unchanged |

**Worked example**

```python
# After being woken with a HITL event:
result = langgraph_resume(payload="approve")
# {
#   "status": "resumed",
#   "flow_id": "flow_abc123",
#   "langgraph_thread_id": "tid_...",
#   "resume_run_id": "run_xyz...",
#   "note": "Flow is back to running and SSE subscriber is attached. ..."
# }

# Yield again — you will be woken on subsequent milestones and the terminal.
sessions_yield(message="Approved. Watching for post-resume events.")
```

**Resuming with feedback**

```python
langgraph_resume(
    payload="block_revise: The output is missing tests for the edge case"
)
# Normalizes to: {decision: "block_revise", feedback: "The output is missing..."}
```

**Resume guard** — if the flow is not in `status: "waiting"`, the tool returns an error. Call `langgraph_inspect` first if unsure of current status. See [failure-modes.md](./failure-modes.md) for the post-resume frame-replay hazard and guard pattern.

**Error reasons**

| reason | meaning | action |
|---|---|---|
| `flow_not_waiting` | Flow exists but is not in `waiting` status | Call `langgraph_inspect` to check status; do not re-resume |
| `resume_already_in_progress` | Another resume call is already in flight | Wait — you'll be woken when the resumed run emits its next event |
| `flow_state_missing_handles` | Flow state missing `langgraph_thread_id`, `workflow`, or `base_url` | Inspect the flow; it may need to be re-dispatched |
| `no_flow_found` | No matching flow found in this session | Check whether workflow was dispatched in this session; may have expired |
| `resume_failed` | Network error, LangGraph server error, or timeout | Retry; if persistent, check LangGraph server health |

---

## Session key shapes

The plugin binds each managed flow to the session key of the dispatching agent turn:

- **Slack DM:** `agent:main:slack:direct:<user_id_lower>`
- **Slack channel thread:** `agent:main:slack:channel:<channel_id_lower>:thread:<thread_ts>`

Set automatically — you don't configure this. Useful for diagnosing misdirected wake events (e.g. wake landing in a later DM instead of the original thread means the flow was dispatched from a different session).

---

## Configuration keys

These live under `plugins.entries.openclaw-langgraph-bridge.config`. Set once at install; rarely touched in normal operation.

| key | default | purpose |
|---|---|---|
| `langgraphBaseUrl` | (required) | Base URL of the LangGraph server, e.g. `http://langgraph.example.com:2024` |
| `callbackToken` | (required) | Bearer token for inbound webhook authentication |
| `callbackPublicBaseUrl` | (optional) | Public base URL the LangGraph server POSTs events to (appended with `/plugins/openclaw-langgraph-bridge/events`) |
| `agentId` | `"main"` | Agent id to wake. Only change if you have multiple named agents on one gateway |
| `allowedWorkflows` | (empty = no restriction) | Allowlist of assistant ids / graph ids the agent may dispatch |
| `defaultTimeoutMs` | `10000` | Per-request timeout for the LangGraph HTTP client |

For full configuration docs, see the [README](../../../README.md) and [docs/](../../../docs/).
