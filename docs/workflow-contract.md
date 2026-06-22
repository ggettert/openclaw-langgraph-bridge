# LangGraph Workflow Contract

This document describes the interface between a LangGraph workflow and the `openclaw-langgraph-bridge` plugin. If you are writing a workflow that integrates with this plugin, this is the document you need.

**Related:** [`src/event-subscriber.ts`](../src/event-subscriber.ts) (SSE subscriber), [`src/webhook-handler.ts`](../src/webhook-handler.ts) (webhook handler), [`src/phase-event.ts`](../src/phase-event.ts) (phase event types), [`docs/phase-event-contract.md`](./phase-event-contract.md) (phase event detail).

---

## Overview

The plugin communicates with a LangGraph workflow over two channels:

1. **SSE stream** — the plugin subscribes to the LangGraph streaming endpoint when it dispatches a workflow. Events on the `updates` and `custom` stream modes are classified and routed.
2. **Webhook callbacks** — if `callbackPublicBaseUrl` is configured, the workflow can POST structured events directly to the plugin's webhook route at any point during the run.

Both channels converge on the same internal `processEvent` router, which decides whether to wake the agent.

---

## Event types

The plugin recognizes five event kinds:

| Kind | What triggers it | Agent action |
|---|---|---|
| `status` | Intermediate progress update; no decision needed | Silent flow-state update — agent is **not** woken |
| `milestone` | Phase started/finished; informational wake | Wakes the agent **unless** `decision_only=true` (the default) |
| `decision` | Workflow requires a human choice | Always wakes the agent |
| `hitl` | Workflow paused at `interrupt()` | Always wakes the agent; flow status set to `waiting` |
| `terminal` | Workflow ended (success or failure) | Always wakes the agent; flow status set to `succeeded` or `failed` |

### `decision_only` semantics

The `langgraph_dispatch` tool accepts a `decision_only` parameter (default `true`).

- `decision_only=true` (default): only `decision`, `hitl`, and `terminal` events wake the agent. `milestone` events update flow state silently.
- `decision_only=false`: `milestone` events also wake the agent, producing a thread post for each phase transition.

`status` events never wake the agent regardless of this setting.

---

## SSE stream contract

### What URL the plugin subscribes to

```
POST {langgraphBaseUrl}/threads/{thread_id}/runs/stream
```

The plugin uses `stream_mode=["updates", "custom"]`. It handles:

- `event: metadata` — first frame; captures `run_id`. Not surfaced to the agent.
- `event: updates` — one frame per node step. Classified as `milestone` (or `hitl` for the `__interrupt__` synthetic node).
- `event: custom` — workflow-authored custom events. Classified based on the `kind` field (see below).
- `event: error` — terminal failure frame.
- `event: end` — stream closed. If no terminal-kind event was seen, the plugin synthesizes a `terminal` (success) event.
- All other event names (e.g. `messages`, `values`, `events`) are silently skipped.

### `event: updates` → `milestone` or `hitl`

The plugin receives an `updates` frame when a workflow node completes. The frame body is `{<node_name>: <node_state_delta>}`.

- Any regular node step → `milestone`.
- Node name `__interrupt__` → `hitl`. LangGraph uses this synthetic node name to signal a HITL interrupt raised by `interrupt()`.

### `event: custom` — custom events from workflow authors

Emit a custom event from a workflow node using the LangGraph stream writer:

```python
from langgraph.config import get_stream_writer

writer = get_stream_writer()
writer({
    "kind": "decision",    # or "status", "milestone", "terminal", "hitl"
    "flow_id": ...,        # injected by the plugin at dispatch time
    "seq": 1,
    "title": "reviewer:finished",
    "summary": "verdict: approve",
    "data": {},
})
```

If the payload matches the [phase event shape](#phase-events) (has `phase`, `event`, `ticket_id`, `summary`), the plugin classifies it automatically — you don't need to set `kind` explicitly.

---

## Webhook callback contract

If `callbackPublicBaseUrl` is configured on the plugin, the workflow can POST events to:

```
POST {callbackPublicBaseUrl}/plugins/openclaw-langgraph-bridge/events
```

### Required headers

| Header | Value |
|---|---|
| `Authorization` | `Bearer <callbackToken>` (the pre-shared secret from plugin config) |
| `Content-Type` | `application/json` |

Requests without a valid `Authorization` header are rejected with HTTP 401. Requests with a missing or unconfigured token are rejected with HTTP 503.

### Request body

```json
{
  "kind": "status" | "milestone" | "decision" | "terminal" | "hitl",
  "flow_id": "<openclaw_flow_id>",
  "seq": 7,
  "title": "coder:finished",
  "summary": "opened PR #42",
  "data": {}
}
```

| Field | Required | Description |
|---|---|---|
| `kind` | ✓ | One of the five event kinds above. Invalid values return HTTP 400. |
| `flow_id` | ✓ | The OpenClaw flow id returned by `langgraph_dispatch`. Missing or empty returns HTTP 400. |
| `seq` | ✓ | Monotonically increasing integer per run. Used for deduplication and ordering. |
| `title` | ✓ | Short machine-readable label (e.g. `"coder:started"`). Shown in the wake message header. |
| `summary` | — | Human-readable one-liner. Shown in the wake message body. Truncated at `summaryMaxChars` (default 4000). |
| `data` | — | Arbitrary JSON object. Stored in flow state for `langgraph_inspect`; not formatted in the wake message. |

Body limit: 64 KB. Larger requests return HTTP 413.

### Response codes

| Code | Meaning |
|---|---|
| `200` | Event accepted and processed |
| `400` | Invalid request (bad JSON, missing `flow_id`, invalid `kind`) |
| `401` | Wrong or missing `Authorization` header |
| `404` | `flow_id` not found (`{"error":"flow_not_found","flow_id":"..."}`) |
| `413` | Body too large |
| `503` | `callbackToken` not configured on the plugin |

---

## Phase events

Phase events are the preferred way for workflow nodes to signal progress. They use the `event: custom` SSE stream and are automatically classified by the plugin.

### Shape

```python
writer({
    "schema_version": 1,       # optional but recommended
    "phase": "coder",          # your phase name
    "event": "started",        # "started" | "finished" | "failed"
    "ticket_id": "BINGO-42",   # ticket identifier
    "summary": "analyzing spec",
    # optional:
    "pr_url": "https://github.com/acme/repo/pull/42",
    "branch": "feature/BINGO-42",
    "verdict": "approve",      # for reviewer:finished
    "error": "RuntimeError: git push rejected",  # for :failed
    "details": {},             # arbitrary extra fields
})
```

### Required fields

| Field | Type | Description |
|---|---|---|
| `phase` | `string` | Phase name, e.g. `"coder"`, `"reviewer"`, `"merge_gate"`, `"merge"`, or any string |
| `event` | `"started" \| "finished" \| "failed"` | Lifecycle point within the phase |
| `ticket_id` | `string` | Ticket identifier, e.g. `"BINGO-42"` |
| `summary` | `string` | Human-readable one-liner shown in the agent's wake message |

### Mode B mapping

| `event` | Plugin kind | Agent action |
|---|---|---|
| `"started"` | `milestone` | Light wake (unless `decision_only=true`) |
| `"finished"` | `milestone` | Light wake (unless `decision_only=true`) |
| `"failed"` | `terminal` | Full wake |

For detailed phase event docs, worked examples, and the full optional field list, see [`docs/phase-event-contract.md`](./phase-event-contract.md).

---

## HITL interrupt shape

When a workflow needs a human decision, call LangGraph's `interrupt()`:

```python
from langgraph.types import interrupt

decision = interrupt({
    "prompt": "Approve this PR?",
    "options": ["approve", "block_revise", "block_abort"],
})
```

The plugin's `langgraph_resume` tool accepts the human's reply and normalizes it before sending it back to LangGraph. Normalization rules:

| Human input | Normalized payload |
|---|---|
| `"approve"`, `"yes"`, `"LGTM"` | `{"decision": "approve", "feedback": ""}` |
| `"block"`, `"block_revise"`, `"no"` | `{"decision": "block_revise", "feedback": ""}` |
| `"block_revise: cleanup the tests"` | `{"decision": "block_revise", "feedback": "cleanup the tests"}` |
| `"block_abort"`, `"abort"`, `"cancel"` | `{"decision": "block_abort", "feedback": ""}` |
| `"extend"` | `{"decision": "extend", "feedback": ""}` |
| Any other string | Passed through as-is |
| Non-string (object, number, etc.) | Passed through as-is |

**Design your `interrupt()` payload to match.** If you expect `{"decision": ..., "feedback": ...}`, the normalized objects above will work. If your workflow expects a raw string (e.g. for a simple yes/no gate), any non-keyword string passes through unchanged.

---

## Minimal example workflow

A minimal Python LangGraph workflow that integrates cleanly with the plugin:

```python
from langgraph.graph import StateGraph, END
from langgraph.config import get_stream_writer
from langgraph.types import interrupt
from typing import TypedDict

class WorkflowState(TypedDict):
    ticket_id: str
    result: str | None

def do_work(state: WorkflowState) -> WorkflowState:
    """Main work node — emits a phase event, then asks for human approval."""
    writer = get_stream_writer()

    # Signal that work started
    writer({
        "schema_version": 1,
        "phase": "worker",
        "event": "started",
        "ticket_id": state["ticket_id"],
        "summary": "processing ticket",
    })

    # ... do actual work here ...

    # Signal completion
    writer({
        "schema_version": 1,
        "phase": "worker",
        "event": "finished",
        "ticket_id": state["ticket_id"],
        "summary": "work complete, awaiting approval",
    })

    # Pause for human approval (HITL gate)
    decision = interrupt({
        "prompt": f"Approve result for {state['ticket_id']}?",
        "options": ["approve", "block_revise", "block_abort"],
    })

    # decision is the normalized payload from langgraph_resume
    if isinstance(decision, dict):
        approved = decision.get("decision") == "approve"
    else:
        approved = str(decision).lower() in ("approve", "yes", "lgtm")

    return {**state, "result": "approved" if approved else "rejected"}


# Build the graph
builder = StateGraph(WorkflowState)
builder.add_node("worker", do_work)
builder.set_entry_point("worker")
builder.add_edge("worker", END)

graph = builder.compile()
```

**What the agent sees:**

1. `langgraph_dispatch` returns a `flow_id`.
2. The plugin streams `updates` frames → `worker:started` milestone wake (if `decision_only=false`) or silent (if `decision_only=true`).
3. The `__interrupt__` node fires → `hitl` event → agent is woken with the interrupt prompt.
4. Agent calls `langgraph_resume` with the human's answer.
5. The resumed stream emits `updates` → `worker:finished` milestone and then `graph:end` → `terminal` wake.

---

## Flow ID

The `flow_id` is generated by the plugin at dispatch time and returned to the agent as part of the `langgraph_dispatch` result. Workflow authors do not need to generate or track it — the plugin manages it internally.

If you are posting webhook events manually, obtain the `flow_id` from the `langgraph_dispatch` tool output.

---

## Summary truncation

All `summary` values (from both SSE and webhook paths) are truncated at `summaryMaxChars` characters (configurable, default 4000) before inclusion in wake messages. Truncation cuts at the last ASCII space within the window and appends ` …[truncated]`. Keep summaries reasonably short for readability — long summaries add noise to conversation threads.
