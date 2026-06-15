import { Type, type Static } from "typebox";
import { definePluginEntry, jsonResult } from "openclaw/plugin-sdk/core";
import { LanggraphClient, LanggraphHttpError } from "./langgraph-client.js";
import { buildHandler, type WebhookHandlerDeps } from "./webhook-handler.js";

/**
 * openclaw-langgraph-bridge — Phase 2
 *
 *   Phase 1 wired langgraph_dispatch end-to-end against a LangGraph dev
 *   server, returning {flow_id, langgraph_thread_id, langgraph_run_id}
 *   and binding the run to a managed TaskFlow.
 *
 *   Phase 2 (this revision) adds the webhook handler at
 *   /plugins/openclaw-langgraph-bridge/events. LangGraph workflows POST
 *   {kind, flow_id, seq, title, summary, data} events to that route; the
 *   handler authenticates, classifies (status / milestone / decision /
 *   terminal / hitl), updates flow state, and conditionally wakes the
 *   originating session via enqueueSystemEvent + requestHeartbeat.
 *
 *   Wire surface kept tight on purpose. Auth = Bearer token comparison
 *   against the configured callbackToken. Body limit 64 KB. Schema
 *   validation rejects unknown kinds. No retry / replay / dedup yet —
 *   Phase 4.
 */

const WEBHOOK_PATH = "/plugins/openclaw-langgraph-bridge/events";

const ConfigSchema = Type.Object({
  langgraphBaseUrl: Type.Optional(
    Type.String({
      description:
        "Base URL of the LangGraph server. Dispatch fails fast when unset.",
      examples: ["http://10.41.1.198:2024"],
    }),
  ),
  callbackToken: Type.Optional(
    Type.String({
      description:
        "Shared secret expected as `Authorization: Bearer <token>` on inbound webhook POSTs. The webhook route refuses requests when unset.",
    }),
  ),
  callbackPublicBaseUrl: Type.Optional(
    Type.String({
      description:
        "Public base URL the LangGraph server should POST events to, e.g. http://kit-host:18794. The plugin appends the route path when dispatching.",
      examples: ["http://127.0.0.1:18794"],
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

type PluginConfig = Static<typeof ConfigSchema>;

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

type DispatchInput = Static<typeof DispatchParams>;

const entry: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "openclaw-langgraph-bridge",
  name: "openclaw-langgraph-bridge",
  description:
    "Bridges an OpenClaw agent acting as orchestrator with one or more LangGraph workflows.",
  configSchema: {
    jsonSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      ...ConfigSchema,
    } as Record<string, unknown>,
  },
  register(api) {
    const logger = api.logger;
    const config = (api.pluginConfig ?? {}) as PluginConfig;

    // ---- 1. Tool: langgraph_dispatch ---------------------------------------
    api.registerTool(
      (toolContext) => {
        const sessionKey = toolContext.sessionKey;
        const baseUrl = config.langgraphBaseUrl;
        const timeoutMs = config.defaultTimeoutMs ?? 10_000;
        const allowed = config.allowedWorkflows;
        const callbackPublic = config.callbackPublicBaseUrl;

        return {
          name: "langgraph_dispatch",
          label: "LangGraph Dispatch",
          description:
            "Dispatch a LangGraph workflow run. The plugin creates a managed TaskFlow bound to the current session, kicks the run, and returns identifiers. status / milestone / decision / terminal / hitl events post back via the plugin webhook and surface as runtime events on the originating session.",
          parameters: DispatchParams,
          execute: async (
            _toolCallId: string,
            paramsUnknown: unknown,
            _signal?: AbortSignal,
          ) => {
            const params = paramsUnknown as DispatchInput;

            if (!baseUrl) {
              return jsonResult({
                status: "error" as const,
                reason: "missing_langgraph_base_url",
                message:
                  "langgraph-bridge is not configured: set `plugins.entries.openclaw-langgraph-bridge.config.langgraphBaseUrl`.",
              });
            }
            if (!sessionKey) {
              return jsonResult({
                status: "error" as const,
                reason: "missing_session_key",
                message:
                  "langgraph_dispatch requires a session-bound tool context.",
              });
            }
            if (allowed && allowed.length > 0 && !allowed.includes(params.workflow)) {
              return jsonResult({
                status: "error" as const,
                reason: "workflow_not_allowed",
                message: `Workflow ${params.workflow} is not in allowedWorkflows.`,
                allowed,
              });
            }

            const client = new LanggraphClient({ baseUrl, timeoutMs });
            const decisionOnly = params.decision_only ?? true;
            const webhookUrl = callbackPublic
              ? callbackPublic.replace(/\/+$/, "") + WEBHOOK_PATH
              : undefined;

            try {
              const flows = api.runtime.tasks.managedFlows.fromToolContext({
                sessionKey,
                deliveryContext: toolContext.deliveryContext,
              });

              const flow = flows.createManaged({
                controllerId: "openclaw-langgraph-bridge",
                goal: `LangGraph workflow: ${params.workflow}`,
                status: "queued",
                stateJson: {
                  workflow: params.workflow,
                  decision_only: decisionOnly,
                  langgraph_base_url: baseUrl,
                  webhook_url: webhookUrl ?? null,
                  phase: "phase-2-pre-langgraph-call",
                },
                currentStep: "dispatch:create-thread",
              });

              const threadId = await client.createThread({
                openclaw_flow_id: flow.flowId,
                openclaw_session_key: sessionKey,
              });

              const run = await client.createRun(threadId, {
                assistantId: params.workflow,
                input: params.input ?? null,
                metadata: {
                  openclaw_flow_id: flow.flowId,
                  openclaw_session_key: sessionKey,
                  openclaw_decision_only: decisionOnly,
                },
                webhook: webhookUrl,
              });

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
                  webhook_url: webhookUrl ?? null,
                  phase: "phase-2-dispatched",
                },
                currentStep: "running",
              });

              logger?.info?.(
                `langgraph_dispatch: dispatched flow=${flow.flowId} thread=${threadId} run=${run.runId} workflow=${params.workflow}`,
              );

              return jsonResult({
                status: "accepted" as const,
                phase: "phase-2",
                flow_id: flow.flowId,
                langgraph_thread_id: threadId,
                langgraph_run_id: run.runId,
                workflow: params.workflow,
                session_key: sessionKey,
                decision_only: decisionOnly,
                webhook_url: webhookUrl ?? "(not configured — events will not route back)",
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
      { name: "langgraph_dispatch" },
    );

    // ---- 2. HTTP route: POST /plugins/openclaw-langgraph-bridge/events -----
    const handlerDeps: WebhookHandlerDeps = {
      expectedToken: config.callbackToken,
      pluginId: "openclaw-langgraph-bridge",
      runtime: {
        tasks: {
          managedFlows: {
            bindSession: (params) =>
              api.runtime.tasks.managedFlows.bindSession({
                sessionKey: params.sessionKey,
              }) as unknown as ReturnType<
                WebhookHandlerDeps["runtime"]["tasks"]["managedFlows"]["bindSession"]
              >,
          },
        },
        system: {
          enqueueSystemEvent: api.runtime.system.enqueueSystemEvent,
          requestHeartbeat: api.runtime.system.requestHeartbeat,
        },
      },
      logger: logger
        ? {
            info: logger.info?.bind(logger),
            warn: logger.warn?.bind(logger),
            error: logger.error?.bind(logger),
          }
        : undefined,
    };

    api.registerHttpRoute({
      path: WEBHOOK_PATH,
      auth: "plugin",
      match: "exact",
      handler: buildHandler(handlerDeps),
    });

    logger?.info?.(
      `openclaw-langgraph-bridge: registered POST ${WEBHOOK_PATH} (token configured: ${Boolean(config.callbackToken)})`,
    );
  },
});

export default entry;
