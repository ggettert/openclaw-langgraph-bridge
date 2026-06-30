# Phase Event Contract — `schema_version: 1`

Custom-stream events emitted by workflow nodes to signal phase transitions.
The plugin's `translatePhaseEventVocabulary` function classifies these into Mode B
wake events that the agent receives in the originating session.

> Python LangGraph syntax is shown throughout this document. [JS/TS LangGraph workflows](https://langchain-ai.github.io/langgraphjs/) emit the same payload shape via the `streamWriter` API — only the SDK call differs.

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

## Recommended pattern — `emit_phase_event` wrapper

Wrap `get_stream_writer()` in a small helper that enforces shape consistency **and
derives an explicit `kind` + `title`** so you don't lean on the bridge's coarse
`started`/`finished`→`milestone` fallback (which wake-storms under `decision_only=false`).
This helper is the recommended reference implementation:

```python
def emit_phase_event(phase, event, ticket_id, summary, *, kind=None, title=None, **extra):
    """Emit a phase event with an explicit bridge `kind` + `title`.

    Setting `kind` routes the payload through the bridge's explicit Mode B path,
    which is checked BEFORE the phase->title mapping — so we also set `title`
    (defaulting to f"{phase}:{event}") to preserve context, otherwise the wake
    title collapses to `custom:<kind>`.

    Default kind derivation (override via the `kind=` arg when needed):
      started                              -> status    (announce; never wakes)
      finished w/ verdict or details.terminal -> milestone (carries an outcome)
      finished (bare)                      -> status    ("phase done" is noise)
      failed                               -> unset     (bridge fallback = terminal)
    """
    from langgraph.config import get_stream_writer

    ev = event.lower()
    if kind is None:
        has_outcome = bool(extra.get("verdict") or (extra.get("details") or {}).get("terminal"))
        if ev == "finished" and has_outcome:
            kind = "milestone"
        elif ev in ("started", "finished"):
            kind = "status"
        # ev == "failed": leave kind unset -> bridge maps it to terminal(failed),
        # which preserves the `phase:failed` title for free.

    payload = {
        "schema_version": 1,
        "phase": phase,
        "event": event,
        "ticket_id": ticket_id,
        "summary": summary,
        **extra,
    }
    if kind is not None:
        payload["kind"] = kind
        payload["title"] = title or f"{phase}:{event}"
    get_stream_writer()(payload)
```

Usage in workflow nodes:

```python
# Phase start — derives kind=status (announcement; never wakes):
emit_phase_event(
    "coder", "started",
    ticket_id=state["ticket_id"],
    summary="analyzing spec",
    branch=state.get("branch"),
)

# Reviewer finish WITH a verdict — derives kind=milestone (carries an outcome):
emit_phase_event(
    "reviewer", "finished",
    ticket_id=state["ticket_id"],
    summary="verdict: approve",
    verdict="approve",
)

# Human-gate decision — no verdict, so force a wake explicitly:
emit_phase_event(
    "merge_gate", "finished",
    ticket_id=state["ticket_id"],
    summary="awaiting human approval",
    kind="milestone",
)

# Failure — leave kind unset; the bridge classifies it as terminal(failed):
emit_phase_event(
    "coder", "failed",
    ticket_id=state["ticket_id"],
    summary="RuntimeError: git push rejected",
    error="RuntimeError: git push rejected",
)
```

---

## Mode B mapping

If a phase event carries **no explicit `kind`**, the plugin's `translatePhaseEventVocabulary`
fallback derives one from the `event` name alone:

| `event` value | Fallback `kind` | Agent action |
|---|---|---|
| `"started"` | `milestone` | Light wake; agent posts short ack |
| `"finished"` | `milestone` | Light wake; agent posts outcome |
| `"failed"` | `terminal` | Full wake; agent posts error summary |

Other `event` values (e.g. `"progress"`) map to `status` (no agent wake by default).

## Set an explicit `kind` (recommended)

> **The fallback is coarse.** It promotes **both** `started` and `finished` to `milestone`.
> With `decision_only=false` that means *every* phase echo wakes the agent — including each
> `:started` from parallel nodes (e.g. three reviewers running concurrently) — which floods
> the thread with low-signal wakes (a "wake-storm").

The plugin honors an explicit `kind` field on the phase payload and passes it through
verbatim, overriding the `event`-name fallback. Valid values: `status`, `milestone`,
`terminal`, `decision`, `hitl`.

```python
emit_phase_event(
    "reviewer", "started",
    ticket_id=state["ticket_id"],
    summary="reviewing diff",
    kind="status",                 # announcement only — never wakes
    title="reviewer:started",      # preserve phase:event context (see caveat)
)
```

> **⚠️ When you set `kind`, also set `title`.** A payload with `kind` takes the explicit
> Mode B path, which is checked **before** `translatePhaseEventVocabulary` and therefore
> skips the phase→title mapping. The plugin then defaults `title` to `custom:<kind>` when
> it's omitted, collapsing many distinct phases into the same wake title (`custom:milestone`,
> `custom:status`, …) and degrading flow history. Pass `title=f"{phase}:{event}"` to keep the
> context. `summary` is preserved either way when present.

Recommended derivation for an `emit_phase_event` wrapper (which should also set
`title=f"{phase}:{event}"` whenever it sets `kind`):

| Condition | `kind` to set | Rationale |
|---|---|---|
| `started` | `status` | Announcement only; should never wake the agent |
| `finished` **with** `verdict` or `details.terminal` | `milestone` | Carries a real outcome worth a wake |
| `finished` bare (no outcome) | `status` | "phase done" echo is noise |
| `failed` | *unset* | Leaving `kind` off takes the phase-event path, which yields `terminal` **and** a `phase:failed` title. Setting `kind="terminal"` reaches the same terminal/`flows.finish()` outcome but collapses the title to `custom:terminal` unless you also set `title`. Omitting `kind` does **not** change whether the flow finishes — `failed` is terminal either way — it just preserves the better title |
| gate/decision frame with no verdict (e.g. `merge_gate`) | `milestone` (+ `title`) | A human-gate decision carries no verdict; force a wake so the agent surfaces it |

This cut a typical sdlc-feature run from ~20 wake frames to ~7 signal frames, correct
regardless of `decision_only`.

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
