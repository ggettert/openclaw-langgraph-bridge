# openclaw-langgraph-bridge

OpenClaw plugin that bridges an OpenClaw agent acting as **orchestrator** with one or more LangGraph workflows acting as **execution**, while keeping per-thread isolation by construction.

The agent stays in control of the conversation. The plugin handles the wire protocol.

> **Status:** Phase 0 scaffold. Ships a single stubbed tool so the loading path can be exercised end-to-end before real LangGraph dispatch lands. See [DESIGN.md](./DESIGN.md) for the full architecture and phase plan.

## The shape

```
human in Slack thread
        │
        ▼
agent (orchestrator) ── langgraph_dispatch ──► plugin ──► langgraph
        ▲                                                     │
        │                  events:                            │
        │                  status   → flow state only         │
        │                  milestone│decision│terminal│hitl   │
        │                  ──────── enqueueSystemEvent +      │
        └────────────────────────── requestHeartbeat ◄────────┘
                                    (webhook in plugin)
```

- Every Slack thread is its own openclaw session → its own orchestrator instance.
- The plugin tracks each LangGraph run as a `managedFlow` bound to that session.
- `status` events are absorbed silently — they update flow state, they do not wake the model.
- `milestone | decision | terminal | hitl` events wake the agent so it can decide what to say.
- HITL replies route back to the same session and are forwarded to LangGraph via the plugin's `inbound_claim` hook (Phase 3).

## Why this exists

See the design history in the carpe `aidlc-fleet-poc` palace drawer if you have access. Short version: the V1 product-bot architecture wants Kit to *be* the orchestrator (not a thin trigger, not a stream-puller) while LangGraph workflows do execution. This plugin is the seam that makes that seamless from inside the agent — no HTTP plumbing visible in the prompt, no sessionKey wrangling, no proxy hacks.

## Build

```bash
npm install
npm run build
npm run plugin:build       # regenerates openclaw.plugin.json from the entry
npm run plugin:validate    # validates the manifest matches the entry
npm test
```

## Install (local dev)

```bash
openclaw plugins install /path/to/openclaw-langgraph-bridge
openclaw plugins inspect openclaw-langgraph-bridge --runtime
```

Restart the gateway. The `langgraph_dispatch` tool should now be visible to the configured agent.

## License

Internal. See repo settings.
