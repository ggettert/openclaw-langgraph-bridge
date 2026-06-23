---
name: langgraph-bridge
description: "Dispatch LangGraph workflows from an agent turn; wake on milestones, HITL gates, and terminal events."
homepage: https://github.com/ggettert/openclaw-langgraph-bridge
metadata:
  openclaw:
    emoji: "🔗"
    requires:
      bins: [openclaw]
---

# langgraph-bridge

Drives durable LangGraph workflows from inside an agent turn. Five tools handle dispatch, inspection, and HITL resume. The plugin wakes the agent proactively on milestone, HITL-interrupt, and terminal events — no polling needed.

Phase event contract: `schema_version: 1` (see [docs/phase-event-contract.md](../../docs/phase-event-contract.md))

---

## When to use

- Dispatching any multi-step, durable LangGraph workflow that runs for minutes or hours.
- When the agent needs proactive wake-backs in the originating Slack thread on milestones or HITL gates.
- When a human's approval must be forwarded back into a running workflow at an interrupt point.
- When you need to discover what workflows are available on the configured LangGraph server.

## When NOT to use

- Synchronous one-shot calls that return in < 1 s — call the downstream API directly.
- Local-only logic that doesn't need durable execution state in LangGraph.
- Writing or modifying the workflow graph itself — this skill is for consumers, not authors.
- Infrastructure provisioning, LangGraph server admin, or gateway setup.

---

## Lifecycle

1. **(optional)** Call `langgraph_inspect_workflow` for any workflow whose input shape you don't already know — read `input_schema.required` before building the input object.
2. **Dispatch** — call `langgraph_dispatch` → plugin creates managed TaskFlow, opens SSE stream, returns `{flow_id, thread_id, run_id}`.
3. **Yield** — call `sessions_yield` → turn ends; plugin streams events in background. Do NOT poll.
4. **Wake** — plugin wakes agent on milestone/HITL/terminal events. Inspect flow state, post one short status message per event.
5. **HITL gate** — if event kind is `hitl`, surface the prompt to the human, wait for reply, then call `langgraph_resume` with the human's answer. Yield again.

See [references/tools.md](./references/tools.md) for full parameter tables and return shapes.

---

## Wake response pattern

- Post **one** short message per wake event: `<emoji> <phase> <event-action> — <summary>`
- **HITL interrupt**: post the prompt and wait for human reply; do not resume without it.
- **Phase milestone**: include outcome detail (PR URL, verdict, etc.) in the summary for `:finished` events; a one-line ack suffices for `:started`.
- **Terminal**: post final summary with emoji (🎉 success, ❌ failure).

`decision_only` (default `true`) — only decision/HITL/terminal events wake the agent; milestone events update flow state silently. Set `decision_only: false` at dispatch to also wake on milestones.

---

## Tools

- `langgraph_list_workflows` — discover available workflows and check allowlist status. See [references/tools.md](./references/tools.md#langgraph_list_workflows).
- `langgraph_inspect_workflow` — read a workflow's input schema before dispatching. See [references/tools.md](./references/tools.md#langgraph_inspect_workflow).
- `langgraph_dispatch` — start a new workflow run. See [references/tools.md](./references/tools.md#langgraph_dispatch).
- `langgraph_inspect` — read current state of an in-flight or completed run. See [references/tools.md](./references/tools.md#langgraph_inspect).
- `langgraph_resume` — resume a workflow paused at a HITL interrupt. See [references/tools.md](./references/tools.md#langgraph_resume).

---

## Discovering unknown workflows

- Don't guess input shapes — LangGraph silently drops unknown keys; downstream nodes will `KeyError` mid-run with no clean dispatch-time error.
- Call `langgraph_inspect_workflow` first; read `input_schema.required` to get all mandatory fields, then construct the `input` object exactly.
- You only need to inspect once per workflow per session — skip if you dispatched it successfully already.

See [references/discovering-workflows.md](./references/discovering-workflows.md) for the full pattern with a worked example.

---

## Failure modes & escape hatch

Common failure patterns (KeyError on missing input, stale flow status, post-resume replay) are documented in [references/failure-modes.md](./references/failure-modes.md). Direct LangGraph API recipes for when the plugin's view diverges from truth: [references/escape-hatch.md](./references/escape-hatch.md).

---

## Worked example

For a worked example using a fleet-style coding workflow (phase events, HITL merge gate, resume patterns), see [references/examples/fleet-style-workflow.md](./references/examples/fleet-style-workflow.md).
