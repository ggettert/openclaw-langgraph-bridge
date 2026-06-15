import { Type, type Static } from "typebox";
import { definePluginEntry, jsonResult } from "openclaw/plugin-sdk/core";
import { LanggraphClient, LanggraphHttpError } from "./langgraph-client.js";
import {
  buildHandler,
  processEvent,
  type WebhookHandlerDeps,
} from "./webhook-handler.js";
import { dispatchAndStream } from "./event-subscriber.js";
import type { IncomingEventBody } from "./webhook-handler.js";
import { formatInspect } from "./inspect-formatter.js";

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

    // Build the shared WebhookHandlerDeps up front so both the tool
    // factory (used by the SSE subscriber) and the HTTP route handler
    // can reference the same object.
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

    // ---- 1a. Tool: langgraph_inspect ---------------------------------------
    // Read the current state of a flow this session owns. With no
    // flow_id argument, returns the most recent flow created by this
    // plugin in the current session.
    api.registerTool(
      (toolContext) => {
        const sessionKey = toolContext.sessionKey;
        return {
          name: "langgraph_inspect",
          label: "LangGraph Inspect",
          description:
            "Inspect a LangGraph flow this session previously dispatched. With no flow_id, returns the latest flow in the current session. Useful for catching up after wakes, checking whether a workflow is waiting on human input, or seeing the terminal summary of a finished run.",
          parameters: Type.Object({
            flow_id: Type.Optional(
              Type.String({
                description: "Specific flow id to inspect. Omit to inspect the latest flow in this session.",
              }),
            ),
          }),
          execute: async (_toolCallId: string, paramsUnknown: unknown) => {
            const params = paramsUnknown as { flow_id?: string };
            if (!sessionKey) {
              return jsonResult({
                status: "error" as const,
                reason: "missing_session_key",
              });
            }
            try {
              const flows = api.runtime.tasks.managedFlows.bindSession({
                sessionKey,
              });
              const record = params.flow_id
                ? (flows.get(params.flow_id) as unknown)
                : (flows.findLatest() as unknown);
              if (!record) {
                return jsonResult({
                  status: "ok" as const,
                  inspect: formatInspect({ flow: null }),
                });
              }
              const flowId = (record as { flowId?: string }).flowId ?? params.flow_id;
              const summary = flowId
                ? ((flows.getTaskSummary?.(flowId) as unknown as string | undefined) ?? null)
                : null;
              return jsonResult({
                status: "ok" as const,
                inspect: formatInspect({
                  flow: record as Parameters<typeof formatInspect>[0]["flow"],
                  taskSummary: summary,
                }),
              });
            } catch (err: unknown) {
              return jsonResult({
                status: "error" as const,
                reason: "inspect_failed",
                message: err instanceof Error ? err.message : String(err),
              });
            }
          },
        };
      },
      { name: "langgraph_inspect" },
    );

    // ---- 1b. Tool: langgraph_dispatch --------------------------------------
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

              // Phase 2 v3: atomic create+stream via POST /threads/{tid}/runs/stream.
              // No race window where a fast run can finish before we subscribe.
              // We get the run_id from the first SSE metadata frame and resolve
              // it back to the caller via a promise.
              const runIdPromise = new Promise<string>((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error("timed out waiting for run_id metadata frame")),
                  timeoutMs,
                );
                let resolved = false;
                const onEvent = (body: IncomingEventBody) => {
                  try {
                    processEvent({
                      body,
                      sessionKey,
                      flowRevision: flow.revision,
                      deps: handlerDeps,
                    });
                  } catch (err: unknown) {
                    const m = err instanceof Error ? err.message : String(err);
                    logger?.warn?.(
                      `langgraph-bridge: subscriber processEvent failed flow=${flow.flowId}: ${m}`,
                    );
                  }
                };
                dispatchAndStream({
                  baseUrl,
                  threadId,
                  flowId: flow.flowId,
                  assistantId: params.workflow,
                  input: params.input ?? null,
                  metadata: {
                    openclaw_flow_id: flow.flowId,
                    openclaw_session_key: sessionKey,
                    openclaw_decision_only: decisionOnly,
                  },
                  handlers: {
                    onRunId: (runId) => {
                      if (!resolved) {
                        resolved = true;
                        clearTimeout(timer);
                        resolve(runId);
                      }
                    },
                    onEvent,
                    onError: (err) => {
                      logger?.warn?.(
                        `langgraph-bridge: stream error flow=${flow.flowId}: ${err.message}`,
                      );
                      if (!resolved) {
                        resolved = true;
                        clearTimeout(timer);
                        reject(err);
                      }
                    },
                    onClose: (sawTerminal) => {
                      logger?.info?.(
                        `langgraph-bridge: stream closed flow=${flow.flowId} sawTerminal=${sawTerminal}`,
                      );
                      // If the stream ended without a terminal-kind event,
                      // emit a synthetic terminal so the agent learns the
                      // run is over.
                      if (!sawTerminal) {
                        try {
                          processEvent({
                            body: {
                              kind: "terminal",
                              flow_id: flow.flowId,
                              title: "graph:end",
                              summary: "workflow completed (no error)",
                            },
                            sessionKey,
                            flowRevision: flow.revision,
                            deps: handlerDeps,
                          });
                        } catch {
                          /* best effort */
                        }
                      }
                    },
                  },
                });
              });

              const runId = await runIdPromise;

              flows.resume({
                flowId: flow.flowId,
                expectedRevision: flow.revision,
                status: "running",
                stateJson: {
                  workflow: params.workflow,
                  decision_only: decisionOnly,
                  langgraph_base_url: baseUrl,
                  langgraph_thread_id: threadId,
                  langgraph_run_id: runId,
                  webhook_url: webhookUrl ?? null,
                  phase: "phase-2-v3-streaming",
                },
                currentStep: "running",
              });

              logger?.info?.(
                `langgraph_dispatch: dispatched flow=${flow.flowId} thread=${threadId} run=${runId} workflow=${params.workflow}`,
              );

              return jsonResult({
                status: "accepted" as const,
                phase: "phase-2-v3",
                flow_id: flow.flowId,
                langgraph_thread_id: threadId,
                langgraph_run_id: runId,
                workflow: params.workflow,
                session_key: sessionKey,
                decision_only: decisionOnly,
                webhook_url:
                  webhookUrl ??
                  "(not configured — terminal callback skipped; SSE stream still active)",
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
    // (terminal-only callback receiver from LangGraph's native webhook
    // field, plus a path for any future workflow-author direct POSTs)
    api.registerHttpRoute({
      path: WEBHOOK_PATH,
      auth: "plugin",
      match: "exact",
      handler: buildHandler(handlerDeps),
    });

    // ---- 3. inbound_claim hook for HITL resume -----------------------------
    // When a human replies in a thread / DM where a langgraph flow is
    // currently waiting on an interrupt, intercept BEFORE the agent
    // routes the message: POST a Command(resume=...) to LangGraph using
    // the captured interrupt_id, clear the wait state, then let the
    // message pass through to the agent so it can acknowledge.
    //
    // Note: the SDK's `registerHook` is typed for the InternalHookHandler
    // shape (one-arg event), but the runtime actually calls inbound_claim
    // with (event, ctx) per PluginHookHandlers. We cast through unknown
    // to use the richer signature.
    const inboundClaimHandler = async (
      event: {
        content?: string;
        sessionKey?: string;
      },
      ctx: { sessionKey?: string },
    ): Promise<void> => {
      const incomingSessionKey = event.sessionKey ?? ctx.sessionKey;
      if (!incomingSessionKey) return;
      const text = (event.content ?? "").trim();
      if (!text) return;

      try {
        const flows = api.runtime.tasks.managedFlows.bindSession({
          sessionKey: incomingSessionKey,
        });
        const flow = flows.findLatest() as
          | undefined
          | {
              flowId: string;
              status?: string;
              revision?: number;
              waitJson?: Record<string, unknown> | string | null;
              stateJson?: Record<string, unknown> | string | null;
            };
        if (!flow || flow.status !== "waiting") return;

        const waitJson = parseMaybeJson(flow.waitJson);
        if (!waitJson || waitJson.kind !== "langgraph_interrupt") return;

        const stateJson = parseMaybeJson(flow.stateJson) ?? {};
        const threadId = stateJson.langgraph_thread_id as string | undefined;
        const workflow = stateJson.workflow as string | undefined;
        const baseUrl =
          (stateJson.langgraph_base_url as string | undefined) ?? config.langgraphBaseUrl;
        if (!threadId || !workflow || !baseUrl) {
          logger?.warn?.(
            `langgraph-bridge: inbound_claim found waiting flow=${flow.flowId} but missing thread/workflow/baseUrl; passing through`,
          );
          return;
        }

        // Resume the langgraph run with the human's reply as the resume payload.
        const client = new LanggraphClient({
          baseUrl,
          timeoutMs: config.defaultTimeoutMs ?? 10_000,
        });
        await client.resumeRun(threadId, workflow, text, {
          metadata: {
            openclaw_flow_id: flow.flowId,
            openclaw_session_key: incomingSessionKey,
            openclaw_resume_source: "inbound_claim",
          },
        });

        // Re-read the current revision before mutating; bindSession's get()
        // would scope incorrectly here so we just resume optimistically with
        // a fresh read.
        const liveFlow = flows.get(flow.flowId) as
          | { revision?: number }
          | undefined;
        const liveRevision = Number(liveFlow?.revision ?? flow.revision ?? 0);

        flows.resume({
          flowId: flow.flowId,
          expectedRevision: liveRevision,
          status: "running",
          currentStep: "resumed",
          stateJson: {
            ...stateJson,
            phase: "phase-3-resumed",
            resume_text_preview: text.slice(0, 200),
            resumed_at: Date.now(),
          },
        });

        logger?.info?.(
          `langgraph-bridge: resumed flow=${flow.flowId} thread=${threadId} from inbound message`,
        );

        // Don't claim the message — let the agent see it and acknowledge
        // ("resumed, watching the run"). The plugin did the side-effect; the
        // conversational ack is the agent's job.
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        logger?.warn?.(`langgraph-bridge: inbound_claim resume failed: ${m}`);
      }
    };

    // SAFETY: cast through unknown because registerHook's declared
    // InternalHookHandler signature is single-arg, but the runtime
    // dispatches inbound_claim with (event, ctx) per the typed hook
    // signature documented in PluginHookHandlers.
    api.registerHook(
      "inbound_claim",
      inboundClaimHandler as unknown as Parameters<
        typeof api.registerHook
      >[1],
    );

    logger?.info?.(
      `openclaw-langgraph-bridge: registered POST ${WEBHOOK_PATH} + inbound_claim hook (token configured: ${Boolean(config.callbackToken)})`,
    );
  },
});

function parseMaybeJson(
  raw: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return raw;
}

export default entry;
