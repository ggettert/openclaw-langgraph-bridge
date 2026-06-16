# openclaw-langgraph-bridge

OpenClaw plugin that bridges an OpenClaw agent (orchestrator) with one or more LangGraph workflows (execution), with per-Slack-thread isolation and proactive wake-back when workflows emit events.

The agent stays in control of the conversation. The plugin handles the wire protocol.

> **Status:** Production-shape. v0.11.0+ ships three tools (`langgraph_dispatch`, `langgraph_inspect`, `langgraph_resume`), an SSE event subscriber for live milestone/HITL/terminal streaming, a webhook endpoint for LangGraph-initiated callbacks, and proactive Slack wake via the `openclaw agent` CLI primitive. See [DESIGN.md](./DESIGN.md) for architecture history and [AUDIT-2026-06-16.md](./AUDIT-2026-06-16.md) for the latest adversarial review.

## The shape

```
human in Slack thread or DM
        │
        ▼
agent (orchestrator) ── langgraph_dispatch ──► plugin ──► LangGraph
        ▲                                                     │
        │                  events stream over SSE:            │
        │                  status   → flow state only         │
        │                  milestone│decision│terminal│hitl   │
        │                  ──────── wakeAgent (CLI) ◄─────────┘
        │
        │
        └── human reply ── langgraph_resume ──► plugin ──► LangGraph
                                                  (command:resume + new SSE)
```

- Every Slack thread / DM is its own openclaw session → its own orchestrator instance
- The plugin tracks each LangGraph run as a `managedFlow` bound to that session
- `status` events absorb silently (flow state only)
- `milestone | decision | terminal | hitl` events wake the agent via `openclaw agent --agent <id> --session-key <key> --message <text>`
- Resume runs open their own SSE subscriber so post-resume events also wake the agent (Phase 5, v0.10.0+)

## Tools

| Tool | Purpose |
|---|---|
| `langgraph_dispatch(workflow, input, decision_only?)` | Start a new workflow run. Returns once LangGraph has accepted the run and emitted a run_id (typically &lt; 10s). |
| `langgraph_inspect(flow_id?)` | Read the current state of a flow. Defaults to the latest flow in this session. |
| `langgraph_resume(payload, flow_id?)` | Resume a workflow that is waiting at a HITL interrupt. Normalizes common keyword replies (`approve`, `block_revise: ...`) into `{decision, feedback}` shape. |

See [`skills/langgraph-bridge/SKILL.md`](./skills/langgraph-bridge/SKILL.md) for the consumer-side reference with worked examples, payload normalization rules, and the canonical dispatch→yield→wake→resume→terminal lifecycle.

## Install

See [INSTALL.md](./INSTALL.md) for the per-bot setup runbook (tarball download, plugin config, gateway config, verification).

## Build from source

```bash
npm install
npm run build
npm test
```

## Configuration

These keys live under `plugins.entries.openclaw-langgraph-bridge.config` in `~/.openclaw/openclaw.json`:

| Key | Required | Default | Purpose |
|---|---|---|---|
| `langgraphBaseUrl` | ✓ | — | Base URL of the LangGraph server (e.g. `http://10.41.1.198:2024`) |
| `callbackToken` | ✓ | — | Bearer token expected on inbound webhook POSTs (`Authorization: Bearer <token>`) |
| `callbackPublicBaseUrl` | — | — | Public base URL the LangGraph server POSTs events to. Plugin appends `/plugins/openclaw-langgraph-bridge/events` |
| `agentId` | — | `"main"` | Agent id to wake when events fire |
| `allowedWorkflows` | — | `[]` (no restriction) | Allowlist of assistant/graph ids the agent may dispatch |
| `defaultTimeoutMs` | — | `10000` | Per-request timeout for the LangGraph HTTP client |

## Why this exists

Carpe's V1 product-bot architecture wants Kit (and other agents) to *be* the orchestrator, not a thin trigger. LangGraph workflows do execution; OpenClaw agents drive decisions and conversation. This plugin is the seam that makes that work from inside an agent turn — no HTTP plumbing in the prompt, no session-key wrangling, no proxy hacks.

## License

Internal. See repo settings.
