# Why this plugin and not MCP?

LangGraph Server (>= `langgraph-api 0.2.3`) natively exposes a `/mcp` endpoint over Streamable HTTP. Any MCP-compatible client can connect and call LangGraph agents as MCP tools. So the obvious question is: why build a dedicated OpenClaw plugin when you could just register LangGraph's `/mcp` endpoint as an MCP server?

The answer is honest: **for the narrow dispatch-only case, MCP works fine.** The plugin's distinct value lives in everything that happens *after* the initial call.

---

## TL;DR

MCP is request/response. `tools/call` returns once.

LangGraph workflows run for seconds to minutes, emit milestone events, pause at HITL gates, may replay frames out of causal order after terminal, and require a resume path that re-attaches to the live event stream. None of that fits a request/response transport. Building it on top of MCP would mean a parallel side-channel for everything except the initial call — at which point you've rebuilt this plugin in a more cumbersome shape.

Three structural gaps:
1. **No event stream back to the consumer.** MCP has no protocol for mid-run events.
2. **No wake mechanism.** When a workflow pauses at a HITL gate or completes, MCP has no way to push that back. The agent would have to poll — which defeats the durability story.
3. **No per-session flow isolation.** OpenClaw sessions are the right abstraction for "the agent reading *this* thread has a flow." MCP doesn't model the agent's session context.

---

## When MCP works for you

If your use case is **one-shot LangGraph dispatch** — call a workflow, get a result, no streaming, no HITL, no per-thread reply routing — you can point OpenClaw's `mcp.servers` config at LangGraph's `/mcp` endpoint and skip this plugin entirely. The workflow appears as a tool to any agent profile that consumes MCP tools. That is a legitimate and simpler path for single-step automation.

---

## When this plugin earns its place

| Concern | LangGraph's built-in `/mcp` | This plugin |
|---|---|---|
| **One-shot dispatch** | ✅ Works via `mcp.servers` registration. | ✅ Works via `langgraph_dispatch`. Equivalent for this case. |
| **Mid-run milestone events back to the agent** | ❌ `tools/call` returns once. No streaming protocol for in-flight events. | ✅ SSE subscriber streams milestones to the originating session as they fire. Agent is woken per event in the correct thread. |
| **HITL interrupt + resume** | ❌ Not modeled in MCP. You'd need a separate side-channel with your own thread tracking and stateful client. | ✅ First-class `langgraph_resume` tool. Plugin owns the `command: {resume: …}` POST and opens a fresh SSE subscriber on the resumed run so post-resume events also wake the agent. |
| **Per-thread / per-session flow isolation** | ❌ MCP is stateless at the protocol layer. | ✅ Plugin's `managedFlows.bindSession` binds each LangGraph thread to the originating session key. Wakes always land in the right conversation thread. |
| **Proactive wake-back** | ❌ None. MCP is poll/call — the agent has to ask. | ✅ The `openclaw agent` CLI primitive wakes the agent's session per event so it can decide what to say — without polling. |
| **State-aware replay handling** | ❌ No protocol concept of post-terminal frames or stale interrupts. | ✅ Terminated-flow guard correctly drops replay frames after `graph:end` so consumers don't double-fire `resume` on stale `hitl` frames. |

---

## Hybrid future

Nothing prevents using both transports. A reasonable future design: `langgraph_dispatch`'s wire call is replaced by an MCP `tools/call` against LangGraph's `/mcp`, while milestone / HITL / terminal events still flow through the plugin's SSE subscriber + webhook handler + wake primitive. The plugin becomes a thinner event-stream layer rather than a wire-protocol wrapper.

This would also enable *third-party MCP clients* (Claude Desktop, OpenAI Agents SDK, etc.) to share the same LangGraph deployment — they use `/mcp` for one-shot calls; the plugin handles the orchestrator path with full streaming. Both coexist.

That is a post-v1.0 design exploration. For now, the plugin owns both surfaces because the wire call and the event stream are entangled enough that splitting them prematurely adds complexity without benefit.
