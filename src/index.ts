import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/core";
import { LanggraphClient, LanggraphHttpError } from "./langgraph-client.js";

/**
 * openclaw-langgraph-bridge — Phase 1
 *
 * Wires `langgraph_dispatch` end-to-end against a LangGraph dev/server:
 *
 *   1. Tool factory closes over the requesting session's `sessionKey`.
 *   2. `managedFlows.fromToolContext(toolContext)` binds a TaskFlow runtime
 *      to that session.
 *   3. `createManaged({controllerId, goal, stateJson:{workflow}})` records the
 *      dispatched run in OpenClaw's native task store, owned by the session.
 *   4. We create a LangGraph thread (so the run has a durable handle) and
 *      start a run against the configured assistant, passing the flow_id and
 *      the originating sessionKey as run metadata. (Phase 2 wires the webhook
 *      that consumes those callbacks.)
 *   5. The tool returns identifiers the agent can reason about and reference
 *      in later turns or `langgraph_inspect` (Phase 3).
 *
 * Phase 2 lands the webhook + event classification (`status` → flow state
 * only, `milestone|decision|terminal|hitl` → wake the agent).
 */

const ConfigSchema = Type.Object({
  langgraphBaseUrl: Type.Optional(
    Type.String({
      description:
        "Base URL of the LangGraph server. Phase 1 tool calls fail fast when unset.",
      examples: ["http://10.41.1.198:2024"],
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
        "Allowlist of assistant ids / graph ids the agent may dispatch. Empty/unset disables the allowlist.",
    }),
  ),
  defaultTimeoutMs: Type.Optional(
    Type.Integer({
      description: "Per-request timeout for the LangGraph HTTP client. Default 10000.",
      minimum: 100,
      maximum: 120000,
    }),
  ),
});

const DispatchParams = Type.Object({
  workflow: Type.String({
    description: "LangGraph assistant id (UUID) or graph id (e.g. 'fleet').",
  }),
  input: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "JSON-serializable input passed to the workflow run.",
    }),
  ),
  decision_only: Type.Optional(
    Type.Boolean({
      description:
        "When true (default), only decision/milestone/terminal events wake the agent; status events update flow state silently. Recorded in flow metadata for the Phase 2 webhook classifier.",
    }),
  ),
});

export default defineToolPlugin({
  id: "openclaw-langgraph-bridge",
  name: "openclaw-langgraph-bridge",
  description:
    "Bridges an OpenClaw agent acting as orchestrator with one or more LangGraph workflows.",
  configSchema: ConfigSchema,
  tools: (tool) => [
    tool({
      name: "langgraph_dispatch",
      label: "LangGraph Dispatch",
      description:
        "Dispatch a LangGraph workflow run. The plugin creates a managed TaskFlow bound to the current session, kicks the run, and returns identifiers. Status / milestone / decision / terminal events post back via the plugin webhook (Phase 2) and surface as runtime events on the originating session.",
      parameters: DispatchParams,
      factory: ({ api, config, toolContext }) => {
        const logger = api.logger;
        const sessionKey = toolContext.sessionKey;
        const baseUrl = config.langgraphBaseUrl;
        const timeoutMs = config.defaultTimeoutMs ?? 10_000;
        const allowed = config.allowedWorkflows;

        return {
          name: "langgraph_dispatch",
          label: "LangGraph Dispatch",
          description:
            "Dispatch a LangGraph workflow run.",
          parameters: DispatchParams,
          execute: async (_toolCallId: string, paramsUnknown: unknown, _signal?: AbortSignal, _onUpdate?: unknown) => {
            const params = paramsUnknown as {
              workflow: string;
              input?: Record<string, unknown>;
              decision_only?: boolean;
            };

            // Pre-flight validation: refuse cleanly when the bridge has nowhere to dispatch to.
            if (!baseUrl) {
              return jsonResult({
                status: "error" as const,
                reason: "missing_langgraph_base_url",
                message:
                  "langgraph-bridge is not configured: set `plugins.entries.openclaw-langgraph-bridge.config.langgraphBaseUrl` to the LangGraph server URL.",
              });
            }

            if (!sessionKey) {
              return jsonResult({
                status: "error" as const,
                reason: "missing_session_key",
                message:
                  "langgraph_dispatch requires a session-bound tool context. Refusing to dispatch with no sessionKey to route events back to.",
              });
            }

            if (allowed && allowed.length > 0 && !allowed.includes(params.workflow)) {
              return jsonResult({
                status: "error" as const,
                reason: "workflow_not_allowed",
                message: `Workflow ${params.workflow} is not in the configured allowedWorkflows list.`,
                allowed,
              });
            }

            const client = new LanggraphClient({ baseUrl, timeoutMs });
            const decisionOnly = params.decision_only ?? true;

            try {
              // 1. Bind a TaskFlow runtime to the requesting session.
              const flows = api.runtime.tasks.managedFlows.fromToolContext({
                sessionKey,
                deliveryContext: toolContext.deliveryContext,
              });

              // 2. Record the dispatched run as a managed flow.
              const goal = `LangGraph workflow: ${params.workflow}`;
              const flow = flows.createManaged({
                controllerId: "openclaw-langgraph-bridge",
                goal,
                status: "queued",
                stateJson: {
                  workflow: params.workflow,
                  decision_only: decisionOnly,
                  langgraph_base_url: baseUrl,
                  phase: "phase-1-pre-langgraph-call",
                },
                currentStep: "dispatch:create-thread",
              });

              // 3. Create a LangGraph thread to host the run.
              const threadId = await client.createThread({
                openclaw_flow_id: flow.flowId,
                openclaw_session_key: sessionKey,
              });

              // 4. Create the run with metadata carrying everything the
              //    Phase 2 webhook will need to route events back.
              const run = await client.createRun(threadId, {
                assistantId: params.workflow,
                input: params.input ?? null,
                metadata: {
                  openclaw_flow_id: flow.flowId,
                  openclaw_session_key: sessionKey,
                  openclaw_decision_only: decisionOnly,
                },
                // webhook intentionally omitted for Phase 1 — Phase 2 wires
                // /plugins/openclaw-langgraph-bridge/events.
              });

              // 5. Update the flow to RUNNING and record the LangGraph handles.
              flows.resume({
                flowId: flow.flowId,
                expectedRevision: flow.revision,
                status: "running",
                stateJson: {
                  workflow: params.workflow,
                  decision_only: decisionOnly,
                  langgraph_base_url: baseUrl,
                  langgraph_thread_id: threadId,
                  langgraph_run_id: run.runId,
                  phase: "phase-1-dispatched",
                },
                currentStep: "running",
              });

              logger?.info?.(
                `langgraph_dispatch: dispatched flow=${flow.flowId} thread=${threadId} run=${run.runId} workflow=${params.workflow}`,
              );

              return jsonResult({
                status: "accepted" as const,
                phase: "phase-1",
                flow_id: flow.flowId,
                langgraph_thread_id: threadId,
                langgraph_run_id: run.runId,
                workflow: params.workflow,
                session_key: sessionKey,
                decision_only: decisionOnly,
                note:
                  "Run started on LangGraph. Status/decision/terminal callbacks land in Phase 2 once the webhook ships.",
              });
            } catch (err: unknown) {
              const message =
                err instanceof LanggraphHttpError
                  ? `LangGraph HTTP error ${err.status}: ${err.message}`
                  : err instanceof Error
                    ? err.message
                    : "Unknown error dispatching to LangGraph";
              logger?.error?.(`langgraph_dispatch: failed: ${message}`);
              return jsonResult({
                status: "error" as const,
                reason: "langgraph_dispatch_failed",
                message,
                http_status:
                  err instanceof LanggraphHttpError ? err.status : undefined,
              });
            }
          },
        };
      },
    }),
  ],
});
