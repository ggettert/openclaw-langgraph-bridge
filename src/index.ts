import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

/**
 * openclaw-langgraph-bridge
 *
 * Phase 0 scaffold: ships one tool, `langgraph_dispatch`, that currently STUBS
 * the real LangGraph call and returns synthetic flow/run identifiers. This
 * exists so we can validate the full plugin loading path end-to-end (install →
 * Kit sees the tool → tool call returns a structured result) before wiring the
 * real managedFlows binding, the webhook handler, and the langgraph HTTP
 * client.
 *
 * Subsequent phases (see DESIGN.md):
 *  - Phase 1: real managedFlows.createManaged + langgraph POST in execute()
 *  - Phase 2: webhook handler (registerPluginHttpRoute + classification)
 *  - Phase 3: langgraph_inspect tool, inbound_claim hook for HITL
 */
export default defineToolPlugin({
  id: "openclaw-langgraph-bridge",
  name: "openclaw-langgraph-bridge",
  description:
    "Bridges an OpenClaw agent acting as orchestrator with one or more LangGraph workflows.",
  configSchema: Type.Object({
    langgraphBaseUrl: Type.Optional(
      Type.String({
        description:
          "Base URL of the LangGraph server. Will be used by Phase 1 dispatch when wired.",
      }),
    ),
    callbackToken: Type.Optional(
      Type.String({
        description:
          "Shared secret the LangGraph workflow includes on inbound webhook POSTs. Required when the webhook handler is wired in Phase 2.",
      }),
    ),
    allowedWorkflows: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Allowlist of workflow ids the agent may dispatch. Empty/unset disables the allowlist.",
      }),
    ),
  }),
  tools: (tool) => [
    tool({
      name: "langgraph_dispatch",
      label: "LangGraph Dispatch",
      description:
        "Dispatch a LangGraph workflow run. The plugin creates a managed TaskFlow bound to the current session, kicks the run, and returns identifiers. Status / milestone / decision / terminal events post back via the plugin webhook and surface as runtime events on the originating session.",
      parameters: Type.Object({
        workflow: Type.String({
          description: "LangGraph workflow / assistant id to dispatch.",
        }),
        input: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: "JSON-serializable input passed to the workflow run.",
          }),
        ),
        decision_only: Type.Optional(
          Type.Boolean({
            description:
              "When true (default), only decision/milestone/terminal events wake the agent; status events update flow state silently.",
          }),
        ),
      }),
      // Phase 0 stub: returns deterministic-looking synthetic ids so the agent
      // can reason about a "dispatched" run during initial smoke tests. Real
      // managedFlows + HTTP dispatch land in Phase 1.
      execute: async ({ workflow, input, decision_only }, _config) => {
        const now = new Date().toISOString();
        const flow_id = `flow_stub_${Date.now().toString(36)}`;
        const run_id = `run_stub_${Date.now().toString(36)}`;
        return {
          status: "accepted",
          phase: "scaffold-stub",
          flow_id,
          run_id,
          workflow,
          input: input ?? null,
          decision_only: decision_only ?? true,
          dispatched_at: now,
          note: "Phase 0 stub. Real LangGraph dispatch + managedFlows binding not yet wired. See DESIGN.md.",
        };
      },
    }),
  ],
});
