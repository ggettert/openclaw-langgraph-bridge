# openclaw-langgraph-bridge

[![npm version](https://img.shields.io/npm/v/openclaw-langgraph-bridge.svg)](https://www.npmjs.com/package/openclaw-langgraph-bridge)
[![CI](https://github.com/ggettert/openclaw-langgraph-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/ggettert/openclaw-langgraph-bridge/actions/workflows/ci.yml)
![Coverage](https://img.shields.io/badge/coverage-92%25-brightgreen.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

An [OpenClaw](https://openclaw.dev) plugin that lets any agent drive [LangGraph](https://github.com/langchain-ai/langgraph) workflows from inside a conversation thread — with per-thread isolation, live event streaming, HITL gate support, and proactive wake-back when workflows emit milestones or reach a terminal state.

The agent stays in control of the conversation. The plugin handles the wire protocol.

---

## Why this exists

**The problem.** Agents asked to own multi-step, long-running execution work become brittle. Same inputs, different outputs. Context windows bloat with execution detail right when you need the agent reasoning sharpest — at approval gates, at production decisions. When something fails three steps into a five-step task, there is no checkpoint to resume from; the agent re-reasons the whole chain with a polluted context. And "what exactly did the agent do?" is answered only by scrolling through the chat history.

The root cause is structural: *a reasoning surface is not a reliable execution engine.* Asking it to be both overloads both roles.

**The architecture.** This plugin enables a clean split: the OpenClaw agent remains the brain and orchestrator — it holds context, makes decisions, talks to humans, and decides *when* to delegate — while LangGraph workflows handle the heavy lifting: discrete nodes, durable checkpointed state, deterministic shape, full observability. The agent dispatches work, then yields. The plugin streams events back over SSE, and wakes the agent in the originating conversation thread when a decision, milestone, HITL gate, or terminal event arrives.

The split is the point: *the agent stops being asked to be a reliable executor; the process stops being asked to be smart.* Each does what it is actually good at.

---

## Quick start

See **[docs/installation.md](./docs/installation.md)** for the full per-bot install runbook: install paths (ClawHub, npm, git, source), plugin config, gateway config, and verification steps.

---

## Tools

The plugin surfaces five tools to the agent:

| Tool | Description |
|---|---|
| `langgraph_list_workflows` | Discover what workflows the LangGraph server exposes (with `allowed: true/false` per any configured allowlist). |
| `langgraph_inspect_workflow` | Read a workflow's input schema before dispatching — use this to validate your input shape. |
| `langgraph_dispatch` | Start a new workflow run. Returns a `flow_id` once LangGraph has accepted the run; the agent can then yield and be woken on events. |
| `langgraph_inspect` | Read the current state of an in-flight or completed run. Defaults to the latest flow in the current session. |
| `langgraph_resume` | Resume a workflow paused at a HITL interrupt. Normalizes common replies (`approve`, `block_revise: ...`) into a typed payload. |

Workflows that talk to this plugin must follow the [workflow contract](./docs/workflow-contract.md).

---

## Architecture

```mermaid
flowchart LR
    H["Human\n(conversation thread)"]
    A["OpenClaw Agent\nbrain + orchestrator"]
    P["openclaw-langgraph-bridge\n5 tools + SSE subscriber\n+ webhook handler"]
    L["LangGraph Workflow\ndurable, checkpointed execution"]

    H <-->|conversation| A
    A -->|dispatch / inspect / resume| P
    P -->|LangGraph SDK HTTP| L
    L -->|SSE event stream| P
    L -.->|webhook callback| P
    P -.->|"milestone | decision | hitl | terminal\nwake-back to originating thread"| A
    A -->|"HITL prompt / summary / decision"| H
```

- Each conversation thread is its own session → its own agent instance with no shared state
- `status` events update flow state silently (no agent wake)
- `milestone`, `decision`, `hitl`, and `terminal` events wake the agent in the originating thread via the `openclaw agent` CLI primitive
- HITL resume opens a new SSE subscriber so post-resume events continue to wake the agent (not fire-and-forget)
- A terminated-flow guard drops replay frames after `graph:end` so consumers don't double-fire `resume` on stale interrupts

---

## Status

Pre-1.0 release. Stable wire protocol, comprehensive test suite, used in production across personal OpenClaw fleets. Pre-1.0 versions may include breaking changes between minor versions; see [CHANGELOG.md](./CHANGELOG.md) for migration notes.

Channel support: tested against Slack (DM + channel threads). Other OpenClaw channels are theoretically supported — the wire protocol and wake primitive are channel-agnostic — but only Slack has been validated end-to-end. See [docs/installation.md → Supported channels](./docs/installation.md#supported-channels) for the compatibility matrix.

---

## Why not MCP?

LangGraph Server natively exposes a `/mcp` endpoint, so the obvious question is "why not register it as an MCP server?"

For one-shot dispatch with no streaming, no HITL, and no per-thread routing: MCP works fine. Use it.

Where this plugin earns its place is everything *after* the initial call: mid-run milestone events, HITL interrupt and resume, per-thread flow isolation, and proactive wake-back. MCP's `tools/call` is request/response — there is no protocol for in-flight events, no way to wake the agent when a workflow pauses at a gate, and no model for per-session flow binding.

See **[docs/why-this-not-mcp.md](./docs/why-this-not-mcp.md)** for the full comparison.

---

## Configuration

Keys live under `plugins.entries.openclaw-langgraph-bridge.config` in `~/.openclaw/openclaw.json`:

| Key | Required | Default | Description |
|---|---|---|---|
| `langgraphBaseUrl` | ✓ | — | Base URL of your LangGraph server (e.g. `http://langgraph.example.com:2024`) |
| `callbackToken` | ✓ | — | Bearer token expected on inbound webhook POSTs |
| `callbackPublicBaseUrl` | — | — | Public base URL the LangGraph server will POST events to. Plugin appends `/plugins/openclaw-langgraph-bridge/events` |
| `allowedWorkflows` | — | `[]` (all) | Optional allowlist of assistant ids / graph ids. When set: `langgraph_dispatch` and `langgraph_inspect_workflow` block non-listed ids; `langgraph_list_workflows` marks blocked ones `allowed: false`. Empty or unset permits all workflows. |

Full config reference: [docs/installation.md → Config reference](./docs/installation.md#config-reference)

---

## Security

### What the plugin stores

- **`callbackToken`** — a pre-shared secret stored in plugin config (`~/.openclaw/openclaw.json`). Used to authenticate inbound webhook POSTs from LangGraph. Never sent to LangGraph; never included in dispatch payloads, URL paths, query strings, or flow metadata.
- **`langgraphBaseUrl`** — the URL of your LangGraph server. Stored in config; sent only as the HTTP target of outbound requests.
- No other credentials are stored by the plugin. Session keys and flow IDs are in-memory only.

### `callbackToken` flow

The plugin registers `POST /plugins/openclaw-langgraph-bridge/events`, authenticated via `Authorization: Bearer <callbackToken>`. See [docs/workflow-contract.md → Webhook callback contract](./docs/workflow-contract.md#webhook-callback-contract) for full request/response details, error codes, and body limits.

### Reporting vulnerabilities

Please use [GitHub Security Advisories](https://github.com/ggettert/openclaw-langgraph-bridge/security/advisories/new) for all security disclosures. **Do not file security issues in the public tracker.** See [SECURITY.md](./SECURITY.md) for the full disclosure policy.

---

## Build from source

```bash
npm ci
npm run build
npm test
```

Requires Node 22+. Tests cover SSE frame classification, payload normalization, event routing, and dispatch streaming.

---

## License

MIT. See [LICENSE](./LICENSE).
