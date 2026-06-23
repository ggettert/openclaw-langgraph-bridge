# Fleet-Style Coding Workflow — Worked Example

This section shows how the langgraph-bridge skill applies to one specific workflow style: the `fleet` coding-agent workflow used for development purposes. It's one example — the patterns (multi-phase milestones, HITL gates, resume) translate well to similar workflows, but the specific phase names, input fields, and emoji assignments are fleet-specific. For your own workflows, the canonical protocol in [SKILL.md](../../SKILL.md) is the source of truth.

---

## Fleet workflow — required input keys

The `fleet` workflow requires exactly three input fields:

```
ticket_id   string   e.g. "ENG-123"
repo        string   e.g. "my-org/my-target-repo"
spec_path   string   path to an existing spec file ALREADY committed to the repo
                     e.g. "feature/ENG-123/tech-spec.md"
                     ← NOT free-text; NOT a ticket title; NOT a description
```

The `spec_path` MUST exist in the repo before dispatch. The workflow's build step will fail with a `RuntimeError` at runtime if the file is missing or if `spec_path` contains anything other than an actual file path.

---

## Inspecting the fleet schema

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
    "output_schema": { "...": "..." },
    "state_schema":  { "...": "..." },
    "config_schema": { "...": "..." }
  }
}
```

---

## Dispatching the fleet workflow

```python
# Step 1: ensure the spec file exists, is committed, and is PUSHED to the remote repo.
#         A pushed feature branch is sufficient — the spec does NOT need to be on
#         main and does NOT need a merged PR. fleet resolves spec_path from the repo
#         directly. Only the committed file path matters.

# Step 2: dispatch
result = langgraph_dispatch(
    workflow="fleet",
    input={
        "ticket_id": "ENG-123",
        "repo": "my-org/my-target-repo",
        "spec_path": "feature/ENG-123/tech-spec.md"
    }
)
# {
#   "status": "accepted",
#   "flow_id": "flow_abc123",
#   "langgraph_thread_id": "tid_...",
#   "langgraph_run_id": "run_...",
#   "workflow": "fleet",
#   "session_key": "agent:main:slack:channel:c01...:thread:1781..."
# }

# Step 3: yield — you will be woken when events fire.
sessions_yield(message="Dispatched fleet run. Will report back on events.")
```

---

## KeyError: 'spec_path' — missing required input field

**Symptom:** dispatch returns `status: "accepted"`, milestone events fire briefly, then workflow fails with `KeyError: 'spec_path'` in a terminal event.

**Root cause:** `spec_path` was missing from the `input` object — or only wrong keys like `ticket_title` or `ticket_description` were provided. LangGraph silently drops keys that don't match the schema.

```python
# ❌ WRONG — wrong keys silently dropped; required key missing
langgraph_dispatch(
    workflow="fleet",
    input={
        "ticket_id": "ENG-123",
        "ticket_title": "Fix the login bug",       # ← dropped silently
        "ticket_description": "Users can't log in", # ← dropped silently
        "repo": "my-org/my-target-repo"
        # spec_path missing entirely
    }
)
# Dispatch succeeds; workflow starts; coder node crashes with KeyError: 'spec_path'.
```

**Fix:**
1. Create the spec file (e.g. `feature/ENG-123/tech-spec.md`) in the repo.
2. Commit and **push** it. A pushed feature branch is enough — no merge to `main` required, no PR required. (Don't burn a merge gate just to land the spec.)
3. Dispatch again with `spec_path` set to the exact file path, not a description.

*Prevention:* call `langgraph_inspect_workflow('fleet')` first; `input_schema.required` surfaces `spec_path` as mandatory before dispatch.

---

## Reacting to fleet phase events

The `fleet` workflow emits milestone wakes for both the start and completion of each long-running phase. **These phases are specific to the `fleet` workflow implementation — your workflow's phases will differ.**

| Event you receive | When it fires | What to post in Slack |
|---|---|---|
| `[langgraph:milestone] designer:started` | Workflow has begun authoring the tech spec | "📐 Designer working on the tech spec for `<ticket_id>`." |
| `[langgraph:milestone] designer:finished` | Spec ready; design gate next | "Spec landed at `<tech_spec_path>`." |
| `[langgraph:milestone] coder:started` | Coder agent dispatched against the spec | "🛠️ Coder picked up `<ticket_id>`, writing code now." |
| `[langgraph:milestone] coder:finished` | PR drafted | "✅ Coder pushed PR `<pr_url>`." |
| `[langgraph:milestone] reviewer:started` | Reviewer agent dispatched against the PR | "👀 Reviewer started reviewing `<pr_url>`." |
| `[langgraph:milestone] reviewer:finished` | Reviewer verdict posted to the PR | "Review complete: verdict `<review_verdict>`." |
| `[langgraph:milestone] merge:started` | Merge gate approved, executing the merge | "🚀 Merging `<pr_url>`." |
| `[langgraph:milestone] merge:finished` | Merge landed | "✅ Merged `<pr_url>`." |

*The user wants to see progress, not just outcomes.* A 2–3 minute silence between `coder:finished` and `reviewer:finished` reads as the workflow being stuck. Surface the `reviewer:started` ack so the user knows the next phase is actively running.

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
- **Don't skip `:started` events.** One emoji + one line. Cheap ack; reduces user anxiety; makes the next silence interpretable.
- **Don't fire long messages on every `:started`.** Save the detailed summary for the corresponding `:finished` event.

### Emoji mapping for fleet phases

| Phase      | started | finished | failed |
|------------|---------|----------|--------|
| designer   | 📐      | ✅       | ❌     |
| coder      | 🛠️      | ✅       | ❌     |
| reviewer   | 👀      | ⚖️       | ❌     |
| merge_gate | 🤝      | (n/a)    | ❌     |
| merge      | 🚚      | 🎉       | ❌     |
| (other)    | ▶️      | ✅       | ❌     |

---

## Resuming a fleet merge_gate interrupt

```python
# After being woken with a HITL event (merge_gate asking for approve/block):
result = langgraph_resume(payload="approve")
# {
#   "status": "resumed",
#   "flow_id": "flow_abc123",
#   "langgraph_thread_id": "tid_...",
#   "resume_run_id": "run_xyz...",
#   "note": "Flow is back to running and SSE subscriber is attached. ..."
# }

# Yield again — you will be woken on subsequent milestones and the terminal.
sessions_yield(message="Approved. Watching for post-merge events.")
```

**Resuming with revision feedback:**

```python
langgraph_resume(
    payload="block_revise: The PR is missing tests for the edge case in login_handler.py"
)
# Normalizes to: {decision: "block_revise", feedback: "The PR is missing..."}
```

---

## Source events and phase vocabulary

The bridge plugin translates fleet's native `{phase, event, …}` custom-stream emissions into Mode B milestone events. Available `<phase>` names (fleet-specific):

- `designer` (started, finished)
- `coder` (started, finished)
- `reviewer` (started, finished)
- `merge` (started, finished, blocked)

**Workflow authors:** see [`docs/phase-event-contract.md`](../../docs/phase-event-contract.md) for the full payload schema, worked examples, and the `emit_phase_event` Python helper.
