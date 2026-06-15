# openclaw-langgraph-bridge — Design

This is the implementation reference. The architectural history (every option considered and rejected, every adversarial review iteration) lives in the carpe `aidlc-fleet-poc` palace drawer. This doc is **just** the design that was landed and the phase plan for building it.

## Goal

Make an OpenClaw agent the orchestrator of LangGraph workflows from inside Slack threads, with these guarantees:

1. **Many humans, many threads, no lockup.** N Slack threads = N parallel openclaw sessions, by openclaw's native routing. Each runs its own orchestrator instance.
2. **Predictable, traceable, clean.** Each LangGraph run binds 1:1 to a `managedFlow` bound to the originating session. Full event audit lives in flow state, not in the model context.
3. **Seamless from the agent's perspective.** Agent calls one tool, ends its turn, gets woken when a decision is actually required. No HTTP, no sessionKey wrangling in the prompt.

## Architecture

### Surfaces

- **One tool:** `langgraph_dispatch(workflow, input, decision_only?)` → `{flow_id, run_id, status}`. Plus a later read tool `langgraph_inspect(flow_id?)` for retrospective context.
- **One webhook route:** `POST /plugins/openclaw-langgraph-bridge/events`. Authenticated by shared secret. Receives the workflow's event posts.
- **One inbound hook:** `inbound_claim`. Intercepts replies in threads where a HITL gate is active, forwards to LangGraph's resume API, optionally absorbs the inbound so the agent isn't double-prompted.

### State: managedFlows only

Every dispatched run gets:

- `createManaged({controllerId: "openclaw-langgraph-bridge", goal, metadata: { workflow, sessionKey, langgraph_thread_id }})`
- Subsequent events update flow state via `runTask` (for status), `setWaiting` (for HITL), `finish` (for terminal).
- No custom SQLite. `managedFlows` *is* the source of truth.

### Event kinds and routing (Mode B)

LangGraph emits events tagged with one of:

| kind | Behavior |
|---|---|
| `status` | Flow state updated via `runTask`. **No wake.** Sits in the system-event queue until the next time the agent wakes for some other reason — at which point it sees the full backlog as context. |
| `milestone` | Flow state updated. `enqueueSystemEvent` + `requestHeartbeat`. Agent wakes to post a milestone note. |
| `decision` | `enqueueSystemEvent` + `requestHeartbeat`. Agent wakes to decide what to say / do. |
| `hitl` | `setWaiting` with the interrupt id in `waitJson`. `enqueueSystemEvent` + `requestHeartbeat`. Agent wakes, asks the human, ends turn. |
| `terminal` | `finishFlow`. `enqueueSystemEvent` + `requestHeartbeat`. Agent posts final summary. |

The decision/status split is the workflow author's choice. They label events at emit time; the plugin enforces the routing.

### HITL flow

1. Workflow hits a gate → emits `kind=hitl` with `interrupt_id` and prompt text.
2. Plugin: `setWaiting(flow_id, waitJson={interrupt_id, prompt})` + wake.
3. Agent posts the question in the Slack thread, ends turn.
4. Human replies in the thread.
5. Plugin's `inbound_claim` hook fires *before* the agent sees the message:
    - Looks up flow by session key → sees `pending interrupt_id`.
    - POSTs `Command(resume=human reply)` to LangGraph.
    - Clears `waitJson`.
    - Optionally absorbs the inbound (claim=true) so the agent doesn't run a turn for it, **OR** lets it through with a synthetic context note ("resumed run X").
6. Workflow continues. Next event arrives as normal.

### SDK primitives in play

Verified at source level before scoping (`/usr/lib/node_modules/openclaw/dist/plugin-sdk/...`):

- `api.runtime.system.enqueueSystemEvent(text, {sessionKey, contextKey?, deliveryContext?})` — queue per-session, **does not wake by itself**. `contextKey` is a (text, contextKey, deliveryContext) dedup tuple.
- `api.runtime.system.requestHeartbeat({source, intent, sessionKey, reason?, coalesceMs?})` — the wake primitive. Pair with `enqueueSystemEvent` for any kind that should escalate to a turn.
- `api.runtime.tasks.managedFlows.bindSession({sessionKey, requesterOrigin})` → returns `BoundTaskFlowRuntime` with `createManaged`, `get`, `list`, `findLatest`, `resolve`, `getTaskSummary`, `setWaiting`, `resume`, `finish`, and the implied `runTask` from the bundled webhooks plugin's `run_task` action.
- `api.on("inbound_claim", handler)` — pre-routing hook for synthetic replies / absorption. Confirmed in the plugin hooks catalog (`docs/plugins/hooks.md`).
- `registerPluginHttpRoute` + `withResolvedWebhookRequestPipeline` from `openclaw/plugin-sdk/webhook-targets` — gives auth, rate limiting, in-flight limits, body size guards out of the box. We do **not** need to extend the bundled `webhooks` plugin.

## Phase plan

### Phase 0 — scaffold (current)

Ship a single stubbed `langgraph_dispatch` tool. Goal is to validate plugin loading end-to-end:

- [x] Package scaffolded via `openclaw plugins init`
- [x] Plugin id renamed to `openclaw-langgraph-bridge`
- [x] `langgraph_dispatch` tool present with stub `execute` returning synthetic IDs
- [ ] Local install → gateway reload → agent sees the tool → tool call succeeds end-to-end
- [ ] Smoke test from a real Slack thread

### Phase 1 — real dispatch

Wire `langgraph_dispatch` to actual `managedFlows` + LangGraph HTTP:

- [ ] Tool factory closes over `api.runtime.tasks.managedFlows` + tool context sessionKey
- [ ] `createManaged` writes the flow with workflow metadata and callback URL/token
- [ ] HTTP client POSTs to LangGraph `/runs` with `metadata = {flow_id, callback_url, callback_token}`
- [ ] Tool returns `{flow_id, run_id, langgraph_thread_id}`
- [ ] First end-to-end smoke: agent dispatches → LangGraph creates the run → no events back yet, but the flow exists in `openclaw tasks`

### Phase 2 — webhook + classification

- [ ] `registerPluginHttpRoute` at `/plugins/openclaw-langgraph-bridge/events`
- [ ] Auth: shared secret via `Authorization: Bearer <callbackToken>`
- [ ] Validation: schema check, seq dedup, flow lookup
- [ ] Classify kind: `status`/`milestone`/`decision`/`terminal`/`hitl` → corresponding flow + queue action
- [ ] Status events get `contextKey` for queue dedup
- [ ] Decision/milestone/terminal/hitl pair with `requestHeartbeat`
- [ ] End-to-end smoke: dispatch run that emits one of each event type; verify agent only wakes on the non-status ones

### Phase 3 — read tool + HITL hook

- [ ] `langgraph_inspect(flow_id?)` reads `get` + `getTaskSummary` and formats for the agent
- [ ] `api.on("inbound_claim", ...)` for HITL Shape B
- [ ] LangGraph resume client integrated
- [ ] End-to-end smoke: workflow that gates, human replies, agent posts question, replies route, workflow continues

### Phase 4 — production hardening

- [ ] Buffer + reorder window for event ordering
- [ ] Per-run audit log
- [ ] Daily reconciliation cron (drift between flow state and LangGraph state)
- [ ] Operational docs: token rotation, plugin upgrade path, SDK version compatibility matrix

## Known risks (carried from adversarial review)

- **Workflow author honesty on event labels.** A workflow that labels everything `decision` collapses Mode B back to Mode A. Lint at workflow registration time, not runtime.
- **Ordering/replay.** Network reorder + at-least-once delivery. Phase 4 fixes; Phase 2 lives with it.
- **Plugin SDK version skew.** Smaller surface area than the rejected v1 design but real ongoing cost. Pin tested OpenClaw versions in `peerDependencies`, exercise via CI before bumping.
