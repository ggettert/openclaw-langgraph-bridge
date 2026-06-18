# Phase Event Contract — `schema_version: 1`

Custom-stream events emitted by workflow nodes to signal phase transitions.
The plugin's `translateFleetVocabulary` function classifies these into Mode B
wake events that the agent receives in the originating session.

**Related:** `src/phase-event.ts` (TypeScript types + validator),
`skills/langgraph-bridge/SKILL.md` (agent-facing skill that reacts to these events).

---

## Overview

A workflow node emits a phase event via the LangGraph streaming writer:

```python
from langgraph.config import get_stream_writer

writer = get_stream_writer()
writer({
    "schema_version": 1,        # optional but recommended
    "phase": "coder",
    "event": "started",
    "ticket_id": "BINGO-42",
    "summary": "analyzing spec",
})
```

The plugin receives this on the `custom` SSE stream, recognises the
`{phase, event}` shape, and maps it to a Mode B event that wakes the agent.

---

## Schema

### Required fields

| Field | Type | Description |
|---|---|---|
| `phase` | `string` | Phase name: `"coder"`, `"reviewer"`, `"merge_gate"`, `"merge"`, or any workflow-defined string |
| `event` | `"started" \| "finished" \| "failed"` | Lifecycle point within the phase |
| `ticket_id` | `string` | Ticket identifier, e.g. `"BINGO-42"` |
| `summary` | `string` | Human-readable one-liner. Shown in the agent's wake message. **Preferred over heuristics** when present. |

### Optional fields

| Field | Type | Description |
|---|---|---|
| `schema_version` | `number` | Always `1` for payloads conforming to this document. Plugin ignores it today; reserved for future parsing rules. |
| `pr_url` | `string \| null` | PR URL, e.g. `"https://github.com/acme/repo/pull/42"` |
| `branch` | `string \| null` | Git branch name, e.g. `"feature/BINGO-42"` |
| `verdict` | `"approve" \| "must_fix" \| "should_fix" \| "abort" \| null` | Reviewer verdict. Set on `reviewer:finished`. |
| `error` | `string \| null` | Short error description for `failed` events. Format: `ErrorType: first line`. No stack trace. |
| `details` | `Record<string, unknown> \| null` | Extra workflow-specific fields. Passed through to `body.data` but not formatted in the wake summary. |

### Summary truncation

The plugin truncates `summary` via `summaryMaxChars` (configurable plugin config, default 4000).
Workflows can emit longer summaries; the wake message will be cut at the configured cap
with a `…[truncated]` suffix. Keep summaries reasonably short for readability.

---

## Worked examples

### `coder:started`

```json
{
  "schema_version": 1,
  "phase": "coder",
  "event": "started",
  "ticket_id": "BINGO-42",
  "summary": "analyzing spec",
  "branch": "feature/BINGO-42"
}
```

Agent receives: milestone wake with title `"coder:started"`, summary `"analyzing spec"`.
Expected post: `🛠️ coder started — analyzing spec`

---

### `reviewer:finished` with verdict

```json
{
  "schema_version": 1,
  "phase": "reviewer",
  "event": "finished",
  "ticket_id": "BINGO-42",
  "summary": "verdict: approve",
  "pr_url": "https://github.com/acme/repo/pull/42",
  "branch": "feature/BINGO-42",
  "verdict": "approve"
}
```

Agent receives: milestone wake with title `"reviewer:finished"`, summary `"verdict: approve"`.
Expected post: `⚖️ reviewer finished — verdict: approve`

---

### `*:failed`

```json
{
  "schema_version": 1,
  "phase": "coder",
  "event": "failed",
  "ticket_id": "BINGO-42",
  "summary": "RuntimeError: git push rejected: non-fast-forward",
  "error": "RuntimeError: git push rejected: non-fast-forward",
  "branch": "feature/BINGO-42"
}
```

Agent receives: terminal wake with title `"coder:failed"`, summary containing
the error. Expected post: `❌ coder failed — RuntimeError: git push rejected: non-fast-forward`

For failures: include `ErrorType: first line` in both `summary` and `error`.
No stack traces — enough to start diagnosis without flooding the thread.

---

### `merge:finished`

```json
{
  "schema_version": 1,
  "phase": "merge",
  "event": "finished",
  "ticket_id": "BINGO-42",
  "summary": "merged https://github.com/acme/repo/pull/42",
  "pr_url": "https://github.com/acme/repo/pull/42"
}
```

Agent receives: milestone wake, expected post: `🎉 merge finished — merged https://...`

---

## Python helper — `emit_phase_event`

The canonical way to emit a phase event from a workflow node is via the
`emit_phase_event` helper in `graph/_shared.py` (devops-langgraph repo, issue #13):

```python
from graph._shared import emit_phase_event

# In a node function:
emit_phase_event(
    "coder",
    "started",
    ticket_id=state["ticket_id"],
    summary="analyzing spec",
    branch=state.get("branch"),
    schema_version=1,
)
```

This wraps `get_stream_writer()` and ensures the payload shape is always correct.

---

## Mode B mapping

The plugin maps phase events to Mode B kinds as follows:

| `event` value | Mode B `kind` | Agent action |
|---|---|---|
| `"started"` | `milestone` | Light wake; agent posts short ack |
| `"finished"` | `milestone` | Light wake; agent posts outcome |
| `"failed"` | `terminal` | Full wake; agent posts error summary |

Other `event` values (e.g. `"progress"`) map to `status` (no agent wake by default).

---

## Backward compatibility

Legacy payloads **without** `summary` or `schema_version` still work. The plugin
falls back to the `summarizeFleetData` heuristic, which builds a summary from
`ticket_id`, `pr_url`, `branch`, `verdict`, etc. if present.

No field renames will be made within `schema_version: 1`. If the contract needs
breaking changes, a new `schema_version` value will be introduced.

---

## Evolution notes

- `schema_version: 1` — initial contract. `summary` field becomes the preferred
  source of the agent-visible one-liner.
- Future versions may add new `event` values (e.g. `"blocked"`, `"retried"`)
  or new required fields. Unknown `event` values degrade to `status` kind
  (no agent wake), so new event types are forward-compatible with old plugin
  versions.
- The plugin currently ignores `schema_version` at runtime; it is recorded for
  future version-dispatch logic.
