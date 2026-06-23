---
name: langgraph-bridge
description: "Drive LangGraph workflows from an agent turn using langgraph_dispatch / langgraph_inspect / langgraph_inspect_workflow / langgraph_list_workflows / langgraph_resume. Agent yields after dispatch and is woken on milestones, HITL gates, and terminal events. Use list_workflows to discover what's available, inspect_workflow to get a workflow's input schema, then dispatch."
argument-hint: "workflow id or graph id, plus structured input matching the target workflow's state schema"
---

# langgraph-bridge

Use this skill whenever you need to dispatch a durable LangGraph workflow from inside an agent turn and receive proactive wake-backs when that workflow emits events (milestones, HITL interrupts, terminal).

Plugin: `openclaw-langgraph-bridge` v0.12.4+  
Phase event contract: `schema_version: 1` (see [docs/phase-event-contract.md](../../docs/phase-event-contract.md))  
Repo: github.com/ggettert/openclaw-langgraph-bridge  
Five tools: `langgraph_dispatch`, `langgraph_inspect`, `langgraph_inspect_workflow`, `langgraph_list_workflows`, `langgraph_resume`

---

## When to use

- Driving a multi-step, durable LangGraph workflow (e.g. the `fleet` coding-agent workflow) that runs for minutes or hours and will pause at HITL gates. _(The example workflow used throughout this skill is named `fleet`; replace with your workflow name.)_
- When the agent needs to be woken in the originating Slack thread or DM when the workflow posts a milestone, decision, or terminal event.
- When the human's approval ("approve", "block_revise: …") needs to be forwarded back into a running workflow at an interrupt point.

## When NOT to use

- **Synchronous one-shot calls** that return in < 1 s — just call the downstream API directly.
- **Local-only logic** that doesn't need durable execution state in LangGraph.
- **Writing or modifying the workflow graph itself** — this skill is for consumers of workflows, not authors.

---

## Wake response pattern (default behaviour)

When woken by ANY event from a dispatched LangGraph flow, post ONE short
status message in the originating thread. No exceptions in v1.

Format: `<emoji> <phase> <event-action> — <summary>`

Summary is truncated by the plugin per its `summaryMaxChars` config (default 4000) before the wake message reaches the skill.

### Examples

- 🚀 Dispatched. Workflow sdlc-feature, run abc123.
- 🛠️ coder started — analyzing spec
- ✅ coder finished — opened https://github.com/.../pull/42
- 👀 reviewer started — running /review
- ⚖️ reviewer finished — verdict: approve
- 🤝 merge_gate started — waiting for human approval
- 🎉 merge finished — merged https://github.com/.../pull/42
- ❌ coder failed — RuntimeError: git push rejected: non-fast-forward

### Emoji mapping

| Phase        | started | finished | failed |
| ------------ | ------- | -------- | ------ |
| coder        | 🛠️       | ✅       | ❌     |
| reviewer     | 👀       | ⚖️        | ❌     |
| merge_gate   | 🤝       | (n/a)    | ❌     |
| merge        | 🚚       | 🎉       | ❌     |
| (other)      | ▶️       | ✅       | ❌     |

Dispatch confirmation (not a phase event): 🚀

### What stays inline / what gets its own post

- HITL interrupt (merge_gate started): post the prompt + wait for human reply
- Reviewer verdict: include in `reviewer finished` summary (set via verdict= field)
- Terminal: emoji per outcome (🎉 success, ❌ failure)

### Suppression list

Empty in v1. Every event posts. Add suppression here if real noise emerges.

### decision_only and phase events

> Note: `langgraph_dispatch` defaults to `decision_only: true`, meaning the
> plugin suppresses milestone events from waking the agent — those events
> update flow state silently without a wake call.
>
> Only **decision**, **HITL**, and **terminal** events wake the agent when
> `decision_only: true` (the default). Status events never wake the agent
> regardless of this setting.
>
> If you want milestone events (e.g. `started`, `step:done`) to also wake
> the agent, set `decision_only: false` at dispatch time. This gives finer-
> grained visibility into workflow progress at the cost of more thread posts.

---

## Canonical lifecycle

```
0. (optional)    for any workflow whose input shape you don't already know:
                 langgraph_inspect_workflow(workflow_id)
                 → read input_schema.properties + input_schema.required
                 → construct the correct input object before dispatching.
                 Skip this step only if you have already dispatched this
                 workflow successfully in this session and know its shape.

1. dispatch      agent calls langgraph_dispatch → plugin creates managed TaskFlow,
                 opens SSE stream to LangGraph, returns {flow_id, thread_id, run_id}
                 in < 10 s (default timeout).

2. yield         agent calls sessions_yield → turn ends. Plugin streams events in
                 the background.

3. milestone     LangGraph emits a milestone frame (node update). Plugin wakes the
     wake         agent in the originating session with event details.

4. hitl          LangGraph hits an __interrupt__. Plugin classifies as "hitl",
     wake         sets flow.status = "waiting", wakes agent with the interrupt prompt.

5. human         Human replies in the thread/DM. Agent calls langgraph_resume with
   replies        the human's answer. Plugin opens a NEW SSE stream on the resumed run
                 (Phase 5, v0.10.0+) — post-resume milestone/terminal events surface.

6. terminal      Workflow ends. Plugin wakes agent with terminal summary in-thread.
     wake
```

**The agent does NOT poll.** After dispatch, yield and wait to be woken. Polling with `langgraph_inspect` inside a tight loop is never needed and wastes turn budget.

---

## Tool reference

### `langgraph_dispatch`

Dispatch a new workflow run. Returns synchronously once LangGraph has accepted the run and returned a run_id (first SSE metadata frame). Event callbacks proceed asynchronously on the SSE stream.

**Parameters**

| param | type | required | notes |
|---|---|---|---|
| `workflow` | string | ✓ | LangGraph assistant UUID or graph id (e.g. `"fleet"`) |
| `input` | object | ✓ (for fleet) | Must match the workflow's state schema exactly — see warning below |
| `decision_only` | boolean | — | Default `true`. When true, only decision/HITL/terminal events wake the agent; milestone events update flow state silently. When false, milestone events also wake the agent. Status events never wake regardless. |

> **⚠ Schema enforcement.** LangGraph silently drops unknown keys in `input`. If your input has the wrong shape, downstream workflow nodes will raise `KeyError` when they try to read a field they expect. You will NOT get a clear error back from dispatch — you'll get a mid-run failure event. Always use the exact schema for your workflow (GET `<langgraph_base_url>/assistants/<assistant_id>/schemas` to inspect).

**`fleet` workflow — required input keys**

```
ticket_id   string   e.g. "<ticket-id>"
repo        string   e.g. "<your-org>/your-target-repo"
spec_path   string   path to an existing spec file ALREADY committed to the repo
                     e.g. "feature/<ticket-id>/tech-spec.md"
                     ← NOT free-text; NOT a ticket title; NOT a description
```

The `spec_path` MUST exist in the repo before dispatch. The workflow's `/build` step will fail with a `RuntimeError` at runtime if the file is missing or if `spec_path` contains anything other than an actual path.

> ⚠️ This example uses a known workflow shape (`fleet`). For any workflow you haven't dispatched before — or if you're not sure the shape hasn't changed — call `langgraph_inspect_workflow` first. See [Discovering and using unknown workflows](#discovering-and-using-unknown-workflows) below.

**Worked example — dispatching the `fleet` workflow**

```python
# Step 1: ensure the spec file exists, is committed, and is PUSHED to the remote repo
#         (a local commit is not enough — the workflow reads it from the remote).
#         A pushed feature branch is sufficient — the spec does NOT need to be on
#         `main` and does NOT need a merged PR. fleet resolves spec_path from the
#         repo directly. (Spec reads fine off the feature branch — only the committed file path matters.)
# Step 2: dispatch
result = langgraph_dispatch(
    workflow="fleet",
    input={
        "ticket_id": "<ticket-id>",
        "repo": "<your-org>/your-target-repo",
        "spec_path": "feature/<ticket-id>/tech-spec.md"
    }
)
# result = {
#   "status": "accepted",
#   "flow_id": "flow_abc123",
#   "langgraph_thread_id": "tid_...",
#   "langgraph_run_id": "run_...",
#   "workflow": "fleet",
#   "session_key": "agent:main:slack:channel:c01...:thread:1781..."
# }

# Step 3: yield. You will be woken when events fire.
sessions_yield(message="Dispatched fleet run. Will report back on events.")
```

**What breaks if spec_path is wrong:**

```python
# ❌ WRONG — free-text gets silently dropped; downstream node KeyErrors
langgraph_dispatch(
    workflow="fleet",
    input={
        "ticket_id": "<ticket-id>",
        "ticket_title": "Fix the login bug",    # ← dropped silently
        "ticket_description": "Users can't log in",  # ← dropped silently
        "repo": "<your-org>/your-target-repo"
        # spec_path missing entirely
    }
)
# Result: dispatch succeeds, workflow starts, coder node crashes with
# KeyError: 'spec_path' mid-run.
```

---

### `langgraph_inspect_workflow`

Fetch the JSON-Schema definitions a workflow expects as input, output, state, and config. Call this **before dispatching any workflow whose input shape you don't already know**.

**Parameters**

| param | type | required | notes |
|---|---|---|---|
| `workflow_id` | string | ✓ | LangGraph assistant UUID or graph id (e.g. `"fleet"`). Must match an assistant registered on the LangGraph server |

**Returns** (on success)

```json
{
  "status": "ok",
  "workflow_id": "fleet",
  "schemas": {
    "input_schema": { "title": "...", "type": "object", "properties": { ... }, "required": [ ... ] },
    "output_schema": { ... },
    "state_schema": { ... },
    "config_schema": { ... }
  }
}
```

The key surface is `schemas.input_schema`. Read `properties` for the available fields and `required` for the mandatory ones. Construct your `langgraph_dispatch` input from these — do not guess.

**When to use**

- Any time you encounter a workflow you have not dispatched before in this session.
- Any time you suspect the workflow's input schema may have changed.
- Skip only if you dispatched this exact workflow successfully earlier in this session and the schema is stable.

**Allowlist enforcement**

If `allowedWorkflows` is configured and the `workflow_id` is not in it, the tool returns an error immediately — no LangGraph call is made:

```json
{ "status": "error", "reason": "workflow_not_allowed", "workflow_id": "..." }
```

**Error reasons**

| reason | meaning | action |
|---|---|---|
| `workflow_not_allowed` | `workflow_id` is not in the configured allowlist | Check `allowedWorkflows` config; use an allowed id |
| `workflow_not_found` | LangGraph server returned 404 for this assistant | Verify the workflow id is correct and the server is running |
| `request_failed` | Network error, timeout, or server 5xx | Retry; if persistent, check LangGraph server health |
| `missing_langgraph_base_url` | Plugin misconfigured | Set `langgraphBaseUrl` in plugin config |

---

### `langgraph_list_workflows`

List every workflow (assistant) available on the configured LangGraph server. Call this when you need to *discover* what workflows you can dispatch — you should not need to know workflow ids out-of-band.

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
      "graph_id": "fleet",
      "name": "Fleet Workflow",
      "description": "Runs the fleet orchestration pipeline",
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
- `workflows[].allowed` — whether this workflow passes the plugin's `allowedWorkflows` config check. If `false`, dispatching or inspecting it will fail with `workflow_not_allowed`.
- `allowlist_active` — `true` when `allowedWorkflows` config is set and non-empty. When `false`, every `allowed: true` is a default — there is no allowlist filtering at all.

**When to use**

- At the start of working with a new bot / new LangGraph deployment: "what's available here?"
- When the user asks for a workflow by name and you want to confirm the id is correct.
- When you suspect the allowlist is blocking you (the response will show which workflows are reachable).

**Pattern**: list workflows → pick the right `graph_id` or `assistant_id` → `langgraph_inspect_workflow` to learn its input shape → `langgraph_dispatch` with the correct input.

**Error reasons**

| reason | meaning | action |
|---|---|---|
| `request_failed` | Network error, timeout, or server 5xx | Retry; if persistent, check LangGraph server health |
| `missing_langgraph_base_url` | Plugin misconfigured | Set `langgraphBaseUrl` in plugin config |

---

### `langgraph_inspect`

Read the current state of a flow this session owns. Returns status, step, and flow metadata from the plugin's managed TaskFlow record.

**Parameters**

| param | type | notes |
|---|---|---|
| `flow_id` | string (optional) | Specific flow to inspect. Omit to inspect the latest flow in this session |

**Use after a wake** to confirm the flow's current status before acting:

```python
state = langgraph_inspect()
# state.inspect contains:
#   flow_id, status (queued/running/waiting/completed/failed),
#   currentStep, workflow, langgraph_thread_id, langgraph_run_id, ...
```

**Known issue — stale status after gateway restart**

The plugin's managed TaskFlow records live in gateway process memory. If the gateway restarts mid-run, `langgraph_inspect` may report the old status (e.g. `"running"`) while LangGraph is actually in a different state (e.g. `"interrupted"` or `"success"`). This was observed in practice: plugin said `"running"`, LangGraph said the thread was at a HITL interrupt with no active run.

When the plugin's status looks wrong, use the direct LangGraph API to check the thread's true state (see [Escape hatch](#direct-langgraph-api-escape-hatch) below).

---

### `langgraph_resume`

Resume a workflow that is paused at a HITL interrupt. Internally opens a fresh SSE subscriber on the resumed run so all post-resume events (milestones, further HITL gates, terminal) continue to surface in this session (Phase 5, v0.10.0+).

**Parameters**

| param | type | notes |
|---|---|---|
| `payload` | any | The human's reply. A plain string is usually correct. See normalization rules below |
| `flow_id` | string (optional) | Specific flow to resume. Omit to resume the latest waiting flow in this session |

**Payload normalization** — the plugin normalizes common HITL string replies into the structured shape `{decision, feedback}` that most `fleet` gate parsers expect:

| raw string | normalized |
|---|---|
| `"approve"`, `"yes"`, `"ok"`, `"lgtm"`, `"approved"` | `{decision: "approve", feedback: ""}` |
| `"block"`, `"block_revise"`, `"revise"`, `"no"` | `{decision: "block_revise", feedback: ""}` |
| `"block_revise: <text>"` or `"block: <text>"` | `{decision: "block_revise", feedback: "<text>"}` |
| `"abort"`, `"stop"`, `"cancel"`, `"block_abort"` | `{decision: "block_abort", feedback: ""}` |
| `"extend"`, `"extend_cap"`, `"continue"` | `{decision: "extend", feedback: ""}` |
| anything else / object | passed through unchanged |

**Worked example — resuming a merge_gate interrupt**

```python
# After being woken with a HITL event (merge_gate asking for approve/block):
result = langgraph_resume(payload="approve")
# result = {
#   "status": "resumed",
#   "flow_id": "flow_abc123",
#   "langgraph_thread_id": "tid_...",
#   "resume_run_id": "run_xyz...",
#   "note": "Flow is back to running and SSE subscriber is attached. ..."
# }

# Yield again. You will be woken on subsequent milestones and the terminal.
sessions_yield(message="Approved. Watching for post-merge events.")
```

**Resuming with feedback:**

```python
langgraph_resume(
    payload="block_revise: The PR is missing tests for the edge case in login_handler.py"
)
# Normalizes to: {decision: "block_revise", feedback: "The PR is missing..."}
```

**Resume guard** — if the flow is not in `status: "waiting"`, the tool returns an error rather than blindly posting to LangGraph. Check `langgraph_inspect` first if unsure.

---

## Discovering and using unknown workflows

### The principle

**Do not guess workflow input shapes from the workflow name.** LangGraph silently drops unknown keys at graph entry — it will accept a malformed input without error and only fail mid-run when a downstream node tries to read a key that was never set. You will see `KeyError: 'some_field'` in a terminal event, not a clean error at dispatch time.

The fix is simple: **inspect first**.

### The pattern

```
1. langgraph_inspect_workflow(workflow_id)  → get the schemas
2. Read input_schema.properties + input_schema.required
   to understand the exact fields the workflow expects
3. langgraph_dispatch(workflow, input={...})  with the correct, complete input
```

You only need to do this once per workflow per session. If you've already dispatched `fleet` successfully in the current session and know its shape, skip the inspect step.

### Worked example — inspecting before dispatching `fleet`

**Step 1 — inspect the schema:**

```python
result = langgraph_inspect_workflow(workflow_id="fleet")
```

Response:

```json
{
  "status": "ok",
  "workflow_id": "fleet",
  "schemas": {
    "input_schema": {
      "title": "FleetState",
      "type": "object",
      "properties": {
        "ticket_id": { "type": "string" },
        "repo":      { "type": "string" },
        "spec_path": { "type": "string" }
      },
      "required": ["ticket_id", "repo", "spec_path"]
    },
    "output_schema": { "..." : "..." },
    "state_schema":  { "..." : "..." },
    "config_schema": { "..." : "..." }
  }
}
```

**Step 2 — read the schema:**

- `input_schema.required` → `["ticket_id", "repo", "spec_path"]` — all three are mandatory.
- `input_schema.properties` → the type of each field (all strings here).

**Step 3 — dispatch with the correct input:**

```python
langgraph_dispatch(
    workflow="fleet",
    input={
        "ticket_id": "<ticket-id>",
        "repo":      "<your-repo>",
        "spec_path": "feature/<ticket-id>/tech-spec.md"
    }
)
```

Because you built `input` directly from the schema's `properties` and `required` lists, no keys will be silently dropped and no downstream node will KeyError.

### When to skip introspection

- You have already dispatched this workflow successfully **in this session** and the shape is stable. Do not call `langgraph_inspect_workflow` on every dispatch — once per session per workflow is enough.
- You maintain an out-of-band schema reference (e.g. this skill file) that you trust and that matches the deployed workflow.

### Error handling

If `langgraph_inspect_workflow` itself fails, **stop and resolve the error before dispatching**:

| `reason` | what happened | what to do |
|---|---|---|
| `workflow_not_found` | The workflow id doesn't exist on the LangGraph server | Double-check the id; verify the LangGraph server is running the expected workflow |
| `workflow_not_allowed` | The id is blocked by the `allowedWorkflows` allowlist | Use an allowed workflow id or update the config |
| `request_failed` | Network error, timeout, or server 5xx | Retry; if persistent, check LangGraph server health |

Do not fall back to guessing the schema if inspection fails — a blind dispatch will almost certainly KeyError mid-run.

---

## Reacting to phase events (`<phase>:started` / `<phase>:finished`)

Workflows like `fleet` emit milestone wakes for *both* the start and the completion of each long-running phase. The bridge plugin translates fleet's native vocabulary into milestone events the agent wakes on:

| Event you receive | When it fires | What to post in Slack |
|---|---|---|
| `[langgraph:milestone] designer:started` | Workflow has begun authoring the tech spec | "📐 Designer working on the tech spec for `<ticket_id>`." |
| `[langgraph:milestone] designer:finished` | Spec ready; design gate next | "Spec landed at `<tech_spec_path>`." |
| `[langgraph:milestone] coder:started` | Coder agent dispatched against the spec | "🔨 Coder picked up `<ticket_id>`, writing code now." |
| `[langgraph:milestone] coder:finished` | PR drafted | "✅ Coder pushed PR `<pr_url>`." |
| `[langgraph:milestone] reviewer:started` | Reviewer agent dispatched against the PR | "👀 Reviewer started reviewing `<pr_url>`." |
| `[langgraph:milestone] reviewer:finished` | Reviewer verdict posted to the PR | "Review complete: verdict `<review_verdict>`." |
| `[langgraph:milestone] merge:started` | Merge gate approved, executing the merge | "🚀 Merging `<pr_url>`." |
| `[langgraph:milestone] merge:finished` | Merge landed | "✅ Merged `<pr_url>`." |

*The user wants to see progress, not just outcomes.* A 2-3 minute silence between `coder:finished` and `reviewer:finished` reads as the workflow being stuck. Surface the `reviewer:started` ack so the user knows the next phase is actively running.

### Pattern

```
for each wake event you receive:
  if event.title matches "<phase>:started":
    post a short "… starting" message to the thread
  elif event.title matches "<phase>:finished":
    post the outcome (PR url, verdict, merge link)
  elif event.kind == "hitl":
    surface the prompt to the human and wait for their reply
  elif event.kind == "terminal":
    post the final summary
```

### What NOT to do

- **Don't post a verdict on `reviewer:started`.** The reviewer hasn't run yet — there is no verdict. The verdict only exists in the `reviewer:finished` event's `review_verdict` field.
- **Don't skip `:started` events.** They're cheap (a one-line ack), they reduce user anxiety, and they make the next 1-3 minutes of silence interpretable.
- **Don't fire long messages on every `:started`.** One emoji + one line. Save the detailed summary for the corresponding `:finished` event.

### Source events

The bridge plugin translates fleet's native `{phase, event, ...}` custom-stream emissions into Mode B milestone events. The available `<phase>` names today (verified against the `fleet` workflow implementation):

- `designer` (started, finished)
- `coder` (started, finished)
- `reviewer` (started, finished)
- `merge` (started, finished, blocked)

A workflow author whose graph emits a different vocabulary may produce different event titles. Use `langgraph_inspect_workflow` to learn the workflow's contract; the schemas show state fields but not custom-event vocabulary, so worst case the agent should observe a few runs and learn the pattern.

**Workflow authors:** see [`docs/phase-event-contract.md`](../../docs/phase-event-contract.md) for the full payload schema, worked examples, and the `emit_phase_event` Python helper.

---

## Failure modes (from real history)

### KeyError: 'spec_path'

**Symptom:** dispatch returns `status: "accepted"`, milestone events fire briefly, then workflow fails with a terminal event containing `KeyError: 'spec_path'` (or another missing field).

**Root cause:** `input` passed to dispatch didn't include the required `spec_path` key. LangGraph schema enforcement silently drops unknown keys; the workflow state was populated with only the keys that matched, so downstream nodes that read `spec_path` raised `KeyError`.

**Fix:**
1. Create the spec file (e.g. `feature/<ticket-id>/tech-spec.md`) in the repo.
2. Commit and **push** it. A pushed feature branch is enough — the spec does NOT
   need to be merged to `main` and does NOT require a PR. (Don't burn a merge
   gate just to land the spec; fleet reads `spec_path` straight from the repo.)
3. Dispatch again with `spec_path` set to the exact file path, not a description.

*Prevention*: call `langgraph_inspect_workflow('fleet')` first; the `required` field of `input_schema` would have surfaced `spec_path` as a mandatory key before dispatch.

### Stale plugin flow status after gateway restart

**Symptom:** `langgraph_inspect` shows `status: "running"`, but no events are arriving and the LangGraph thread is actually at a HITL interrupt or already completed.

**Root cause:** Plugin managed TaskFlow state lives in process memory. A gateway restart wipes it. The plugin's view and LangGraph's view diverge.

**Fix:** Use the direct LangGraph API to check truth (see escape hatch below), then call `langgraph_resume` with the correct payload if the thread is waiting, or take no action if it already completed.

### Post-resume events not surfacing

> **This is fixed in v0.10.0+ (Phase 5).** Post-resume milestone and terminal
> events now surface correctly via the fresh SSE subscriber opened on each resume.
> The note below is kept for context on pre-v0.10.0 installs only.

**Symptom (pre-v0.10.0 only):** `langgraph_resume` returns `status: "resumed"`, but the agent is never woken again — even though the workflow continued running, passed through more milestones, and reached a terminal.

**Root cause:** Before Phase 5 (v0.10.0), `langgraph_resume` POSTed to `/threads/{tid}/runs` fire-and-forget. No SSE subscriber was opened on the new run, so events from the resumed graph never reached `processEvent` and never triggered a wake. This was the dogfood scenario that caught this — the merge landed on LangGraph but the agent was never woken about the terminal.

**Fix:** This is fixed in v0.10.0+. The `langgraph_resume` tool now routes through `dispatchAndStream` with `command: {resume: payload}`, opening an identical SSE subscriber to the initial dispatch. If you are on v0.12.4+ this is not your issue — check plugin config or session binding instead.

### Post-resume frame replay / out-of-order events

**Symptom:** after a successful `langgraph_resume` (e.g. approving a `merge_gate`),
the session is woken by a flurry of trailing frames that arrive *out of order* and
*after* the work has actually completed: a **second `merge_gate` HITL interrupt**,
followed by `merge:started` / `merge:finished` / `node:merge` recap milestones —
some landing *after* the `graph:end` terminal frame.

**Root cause:** the resumed run opens a fresh SSE subscriber (Phase 5, v0.10.0+),
and the post-resume event stream can replay/buffer node frames rather than deliver
them in strict causal order. The duplicate `merge_gate` frame is stale — the gate
was already satisfied by the resume — but a consumer that reacts to frame *kind*
alone could **double-fire `langgraph_resume`** into an already-completed flow.

**Fix (v0.11.2+):** The plugin now handles this server-side. `processEvent`
checks the flow's status before any mutation; if the flow is already in a
terminal state (`succeeded`, `failed`, `cancelled`, `lost` per the OpenClaw
`TaskFlowStatus` enum), the stale frame is dropped with action
`ignored:post-terminal` — no `setWaiting` call, no wake fired, no risk of
double-firing `langgraph_resume`. Closed by #10 (M5) and #16 in v0.11.2.

**Belt-and-suspenders guard for pre-v0.11.2 installs (still good practice anyway):**
1. **`langgraph_inspect` before you `langgraph_resume`.** Treat `langgraph_inspect`
   as ground truth, not the raw frame. Treat ANY of these as terminal: `status:
   "succeeded"`, `"failed"`, `"cancelled"`, `"lost"`, or a `graph:end` summary
   in flow state. If terminal, a trailing `merge_gate` HITL frame is stale — do
   **not** call `langgraph_resume` again.
2. The `langgraph_resume` guard helps (it errors unless the flow is `waiting`),
   but don't rely on it alone — confirm state with `langgraph_inspect` first.
3. Trailing recap milestones (`merge:*`, `node:merge`) after terminal are
   informational replay; verify the real outcome out-of-band (e.g. `gh pr view`)
   and don't re-post duplicates.

### LangGraph POC unreachable

**Symptom:** `langgraph_dispatch` returns `status: "error"` with a message like `ETIMEDOUT` or `connect ECONNREFUSED`. Or the call hangs until the 10 s client timeout.

**Root cause:** The LangGraph server is down, overloaded, or the route is blocked.

**Fix:** Restart your LangGraph server and retry. If the connection times out (vs. refused), the host is up but the port is not listening — check routing and confirm the port is listening (e.g. `lsof -i :<port>` or `ss -tlnp | grep <port>`).

### Wake reply lands at channel root, not in thread (pre-v0.11.0)

**Symptom:** When a workflow event fires and the plugin wakes the agent, the agent's reply appears at channel root instead of inside the originating thread.

**Root cause:** `openclaw agent` CLI has no `--thread-id` flag and the runtime doesn't synthesize Slack reply context from the session-key shape alone. Pre-v0.11.0, wake messages contained no guidance on where to reply.

**Fix (v0.11.0+):** Wake messages for thread-bound sessions now include a `[reply-hint]` line at the top:

```
[reply-hint] This wake was bound to a Slack thread. Reply IN-THREAD by
passing threadId="<ts>" on your next message tool call (channel=<ch>).
Default outbound otherwise lands at channel root.
```

Honour the hint. Extract the `threadId` and `channel` values from the hint and pass them in your outbound message tool call.

---

## Direct LangGraph API escape hatch

Use direct HTTP calls when:
- The plugin's flow status is stale (e.g. after gateway restart) and you need truth.
- `langgraph_resume` can't find the flow (flow record was lost with the gateway restart).
- You need to inspect raw thread state or run history.

**Check thread state:**
```bash
curl -s http://localhost:2024/threads/<langgraph_thread_id>/state \
  | jq '{status: .status, next: .next, values_keys: (.values // {} | keys)}'
```

**Resume via direct API (when plugin resume fails):**
```bash
curl -s -X POST http://localhost:2024/threads/<tid>/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "assistant_id": "fleet",
    "command": {"resume": {"decision": "approve", "feedback": ""}}
  }'
```

After a direct-API resume, the plugin has no SSE subscriber on the new run. Post-resume events will not surface via the wake mechanism. You'll need to poll thread state manually or wait for the workflow's native webhook callback (if configured).

---

## Session key shapes

The plugin binds each managed flow to the session key of the dispatching agent turn. Session key format:

- **Slack DM:** `agent:main:slack:direct:<user_id_lower>`
- **Slack channel thread:** `agent:main:slack:channel:<channel_id_lower>:thread:<thread_ts>`

The plugin handles session binding automatically. You don't set this — it comes from the tool context. It's useful to know when diagnosing wake routing: if wake events are landing in the wrong session (e.g. a later DM instead of the original thread), the flow was dispatched from a different session than where you're responding.

---

## Configuration (plugin config keys)

These live under `plugins.entries.openclaw-langgraph-bridge.config`. In normal operation you don't touch them; they are set once at install.

| key | default | purpose |
|---|---|---|
| `langgraphBaseUrl` | (required) | Base URL of the LangGraph server, e.g. `http://langgraph.example.com:2024` |
| `callbackToken` | (required) | Bearer token for inbound webhook authentication |
| `callbackPublicBaseUrl` | (optional) | Public base URL the LangGraph server POSTs events to (appended with `/plugins/openclaw-langgraph-bridge/events`) |
| `agentId` | `"main"` | Agent id to wake. Only change if you have multiple named agents on one gateway |
| `allowedWorkflows` | (empty = no restriction) | Allowlist of assistant ids / graph ids the agent may dispatch |
| `defaultTimeoutMs` | `10000` | Per-request timeout for the LangGraph HTTP client |

---

## Out of scope

- Writing or modifying LangGraph workflow graphs.
- Infrastructure provisioning (LangGraph server, EC2 POC, networking).
- LangGraph server administration (upgrades, thread cleanup, log rotation).
- OpenClaw gateway setup or plugin installation.
- Authoring the `fleet` workflow itself — see `<your-org>/your-langgraph-workflows`.
