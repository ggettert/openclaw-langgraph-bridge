import { Type, type Static } from "@sinclair/typebox";
// jsonResult(payload) wraps via textResult(text, payload) → { content: [{type:"text",text}], details: payload }.
// The payload is always available at `.details` on the returned object — this is a stable SDK contract.
import { definePluginEntry, jsonResult } from "openclaw/plugin-sdk/core";
import { LanggraphClient, LanggraphHttpError } from "./langgraph-client.js";
import { buildHandler, processEvent, type WebhookHandlerDeps } from "./webhook-handler.js";
import { dispatchAndStream } from "./event-subscriber.js";
import type { IncomingEventBody } from "./webhook-handler.js";
import { formatInspect } from "./inspect-formatter.js";
import { parseMaybeJson } from "./utils.js";
import { WakeBudget } from "./wake-budget.js";
import { WakeDedup } from "./wake-dedup.js";

/** Default per-request timeout for the LangGraph HTTP client (ms). */
const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// In-flight SSE controller registry (F4)
// ---------------------------------------------------------------------------
// Tracks all active `dispatchAndStream` AbortControllers so that a SIGTERM
// can cancel every open SSE connection before the process exits.

/** All currently open SSE AbortControllers. */
export const _inflightControllers = new Set<AbortController>();

let _sigtermRegistered = false;

/** Register the SIGTERM handler exactly once (idempotent). */
export function _ensureSigtermHandler(): void {
  if (_sigtermRegistered) return;
  _sigtermRegistered = true;
  process.on("SIGTERM", () => {
    for (const c of _inflightControllers) c.abort();
    _inflightControllers.clear();
  });
}

_ensureSigtermHandler();

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
 *   originating session via the `openclaw agent` CLI wake primitive
 *   (Phase 4 — see ./wake-agent and ./webhook-handler).
 *
 *   Wire surface kept tight on purpose. Auth = Bearer token comparison
 *   against the configured callbackToken. Body limit 64 KB. Schema
 *   validation rejects unknown kinds. No retry / replay / dedup yet —
 *   Phase 4.
 */

const WEBHOOK_PATH = "/plugins/openclaw-langgraph-bridge/events";

export const ConfigSchema = Type.Object({
  langgraphBaseUrl: Type.Optional(
    Type.String({
      description: "Base URL of the LangGraph server. Dispatch fails fast when unset.",
      examples: ["http://langgraph.example.com:2024"],
    }),
  ),
  callbackToken: Type.Optional(
    Type.String({
      description:
        "Shared secret expected as `Authorization: Bearer <token>` on inbound webhook POSTs. The webhook route refuses requests when unset.",
    }),
  ),
  agentId: Type.Optional(
    Type.String({
      description:
        "Agent id to wake via `openclaw agent` when a LangGraph event requires waking the session-bound agent. Default 'main'. Plumbed through to wake-agent.ts.",
      examples: ["main"],
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
  summaryMaxChars: Type.Optional(
    Type.Integer({
      description:
        'Maximum characters for event summaries in wake messages. Summaries longer than this cap are truncated at the last ASCII space (0x20) and a " \u2026[truncated]" marker is appended; other whitespace (newlines, tabs) is not treated as a cut point. Default 4000.',
      minimum: 100,
      maximum: 50000,
      examples: [4000],
    }),
  ),
  langgraphApiKey: Type.Optional(
    Type.String({
      description:
        "API key for LangSmith Deployment (LangChain's hosted LangGraph). Sent as x-api-key header on all outbound HTTP calls to the LangGraph server. Not required for langgraph dev or self-hosted Aegra deployments.",
      minLength: 1,
      pattern: "^[A-Za-z0-9._\\-+/=]+$",
    }),
  ),
  langgraphAuthScheme: Type.Optional(
    Type.String({
      description:
        'Auth scheme sent as x-auth-scheme alongside x-api-key. Required for LangSmith Fleet deployments (value: "langsmith-api-key"). Leave unset for standard LangSmith Deployment, Aegra, or langgraph dev.',
      minLength: 1,
      pattern: "^[A-Za-z0-9._\\-+/=]+$",
    }),
  ),
  wakeBudget: Type.Optional(
    Type.Object(
      {
        maxWakesPerFlowPerWindow: Type.Optional(
          Type.Integer({
            description:
              "Maximum agent wakes issued per flow_id per rolling window before the budget coalesces further wakes into a single trailing-edge wake. Default 15.",
            minimum: 1,
            maximum: 1000,
            examples: [15],
          }),
        ),
        windowMs: Type.Optional(
          Type.Integer({
            description:
              "Rolling window size in milliseconds for the per-flow wake budget. Default 60000 (1 minute).",
            minimum: 1000,
            maximum: 3600000,
            examples: [60000],
          }),
        ),
      },
      {
        description:
          "Per-flow wake-budget circuit breaker (issue #91). Caps agent wakes at maxWakesPerFlowPerWindow per windowMs; excess wakes are coalesced into one trailing-edge wake. Set maxWakesPerFlowPerWindow to a very high number to effectively disable.",
      },
    ),
  ),
  dedup: Type.Optional(
    Type.Object(
      {
        enabled: Type.Optional(
          Type.Boolean({
            description:
              "Enable same-key milestone dedup + parallel-fanout collapse. Default true. Set false to restore pre-#91 behaviour (every milestone wakes immediately).",
            examples: [true],
          }),
        ),
        windowMs: Type.Optional(
          Type.Integer({
            description:
              'Dedup / fanout-coalesce window in milliseconds. Same-key milestone repeats and concurrent "finished" keys within this window are folded into one trailing-edge wake. Default 5000 (5 s).',
            minimum: 100,
            maximum: 300000,
            examples: [5000],
          }),
        ),
      },
      {
        description:
          "Same-node milestone dedup + parallel-fanout collapse (issue #91). Set enabled=false and a high wakeBudget to restore pre-#91 behaviour (escape hatch).",
      },
    ),
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
        "When true (default), only decision/HITL/terminal events wake the agent; milestone events update flow state silently. When false, milestone events also wake the agent. Status events never wake regardless.",
    }),
  ),
  milestone_model: Type.Optional(
    Type.String({
      description:
        "Optional model override forwarded as `--model <value>` to the `openclaw agent` CLI on milestone-event wakes only (e.g. coder started/finished, reviewer node started/finished). Use a faster model (e.g. anthropic/claude-sonnet-4-6) for these high-frequency status posts while leaving decision/HITL/terminal wakes on the session's primary model. Accepts arbitrary provider/model strings (no bridge-side validation); the gateway is the source of truth on what's allowed. If the gateway rejects the value (\"Model override X is not allowed for agent Y\"), the bridge logs a WARN, caches the rejection per flow_id, and retries the wake without `--model` so the workflow keeps producing visible events. Decision/HITL/terminal wakes always use the session's primary model and ignore this override.",
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
      agentId: config.agentId ?? "main",
      summaryMaxChars: config.summaryMaxChars ?? 4000,
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
      },
      logger: logger
        ? {
            info: logger.info?.bind(logger),
            warn: logger.warn?.bind(logger),
            error: logger.error?.bind(logger),
          }
        : undefined,
      // Phase 1 (#91): per-flow wake budget.
      wakeBudget: new WakeBudget({
        maxWakesPerFlowPerWindow: config.wakeBudget?.maxWakesPerFlowPerWindow ?? 15,
        windowMs: config.wakeBudget?.windowMs ?? 60_000,
      }),
      // Phase 2 (#91): same-key dedup + fanout collapse.
      wakeDedup: new WakeDedup({
        enabled: config.dedup?.enabled ?? true,
        windowMs: config.dedup?.windowMs ?? 5_000,
      }),
    };

    // Concurrent-resume guard (#9): prevents TOCTOU race between status check
    // and dispatchAndStream. Without this, two simultaneous langgraph_resume
    // calls on the same flow_id can both pass the `status === "waiting"` guard
    // and each open a duplicate SSE stream + LangGraph run.
    //
    // Lock-release point: we hold the lock through `flows.resume()` (option 2).
    // Releasing after `await runIdPromise` would leave a narrow window where a
    // second caller's status check fires between runIdPromise resolving and
    // flows.resume() transitioning the flow to "running" — it would still see
    // "waiting" and bypass the guard. Holding through flows.resume() closes
    // that residual race at the cost of a single extra synchronous call inside
    // the lock. The window is <1 ms in practice but the correctness guarantee
    // is worth it.
    const resumeInProgress = new Set<string>();

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
                description:
                  "Specific flow id to inspect. Omit to inspect the latest flow in this session.",
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

    // ---- 1b. Tool: langgraph_inspect_workflow ------------------------------
    // Fetch the JSON-Schema shapes a workflow expects as input/output/state.
    // Agents MUST call this before dispatching any workflow whose input shape
    // they don't already know; LangGraph silently drops unknown keys and
    // downstream nodes KeyError mid-run (root cause of schema mismatch bugs).
    api.registerTool(
      (_toolContext) => {
        const baseUrl = config.langgraphBaseUrl;
        const timeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        const allowed = config.allowedWorkflows;
        const langgraphApiKey = config.langgraphApiKey;
        const langgraphAuthScheme = config.langgraphAuthScheme;

        return {
          name: "langgraph_inspect_workflow",
          label: "LangGraph Inspect Workflow",
          description:
            "Inspect the schema(s) of a LangGraph workflow before dispatching it. Returns input_schema / output_schema / state_schema / config_schema as published by the LangGraph server. Call this BEFORE dispatching any workflow whose input shape you don't already know — LangGraph silently drops unknown keys and downstream nodes will KeyError mid-run if you guess wrong.",
          parameters: Type.Object({
            workflow_id: Type.String({
              description:
                "LangGraph assistant id (UUID) or graph id (e.g. 'fleet'). Must match an assistant registered on the LangGraph server.",
            }),
          }),
          execute: async (_toolCallId: string, paramsUnknown: unknown) => {
            const params = paramsUnknown as { workflow_id: string };
            const workflowId = params.workflow_id;

            if (!baseUrl) {
              return jsonResult({
                status: "error" as const,
                reason: "missing_langgraph_base_url",
                message:
                  "langgraph-bridge is not configured: set `plugins.entries.openclaw-langgraph-bridge.config.langgraphBaseUrl`.",
              });
            }

            if (allowed && allowed.length > 0 && !allowed.includes(workflowId)) {
              return jsonResult({
                status: "error" as const,
                reason: "workflow_not_allowed",
                message: `Workflow ${workflowId} is not in allowedWorkflows.`,
                workflow_id: workflowId,
              });
            }

            const client = new LanggraphClient({
              baseUrl,
              timeoutMs,
              apiKey: langgraphApiKey,
              authScheme: langgraphAuthScheme,
            });
            try {
              const schemas = await client.getAssistantSchemas(workflowId);
              return jsonResult({
                status: "ok" as const,
                workflow_id: workflowId,
                schemas,
              });
            } catch (err: unknown) {
              if (err instanceof LanggraphHttpError && err.status === 404) {
                return jsonResult({
                  status: "error" as const,
                  reason: "workflow_not_found",
                  workflow_id: workflowId,
                  message: `Workflow '${workflowId}' not found on the LangGraph server (404).`,
                });
              }
              const message = err instanceof Error ? err.message : String(err);
              return jsonResult({
                status: "error" as const,
                reason: "request_failed",
                workflow_id: workflowId,
                message,
              });
            }
          },
        };
      },
      { name: "langgraph_inspect_workflow" },
    );

    // ---- 1c. Tool: langgraph_list_workflows --------------------------------
    // Discovery tool: ask the LangGraph server what workflows (assistants)
    // are available. Returns each with an `allowed` annotation based on
    // the plugin's `allowedWorkflows` config so agents can see what exists
    // vs. what they can actually dispatch.
    api.registerTool(
      (_toolContext) => {
        const baseUrl = config.langgraphBaseUrl;
        const timeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        const allowedWorkflows = config.allowedWorkflows;
        const langgraphApiKey = config.langgraphApiKey;
        const langgraphAuthScheme = config.langgraphAuthScheme;

        return {
          name: "langgraph_list_workflows",
          label: "LangGraph List Workflows",
          description:
            "List the LangGraph workflows available on this server. Returns each workflow's `assistant_id`, `graph_id`, `name`, and `description`. Use this to discover what workflows you can dispatch. Workflows blocked by the plugin's `allowedWorkflows` config are still listed but marked as `allowed: false` so you can see what exists vs. what you can actually call.",
          parameters: Type.Object({}),
          execute: async (_toolCallId: string, _paramsUnknown: unknown) => {
            if (!baseUrl) {
              return jsonResult({
                status: "error" as const,
                reason: "missing_langgraph_base_url",
                message:
                  "langgraph-bridge is not configured: set `plugins.entries.openclaw-langgraph-bridge.config.langgraphBaseUrl`.",
              });
            }

            const allowlistActive = Array.isArray(allowedWorkflows) && allowedWorkflows.length > 0;

            const client = new LanggraphClient({
              baseUrl,
              timeoutMs,
              apiKey: langgraphApiKey,
              authScheme: langgraphAuthScheme,
            });
            try {
              const assistants = await client.searchAssistants(100);
              const workflows = assistants.map((a) => ({
                assistant_id: a.assistant_id,
                graph_id: a.graph_id,
                name: a.name,
                description: a.description,
                allowed: allowlistActive
                  ? allowedWorkflows!.includes(a.assistant_id) ||
                    allowedWorkflows!.includes(a.graph_id)
                  : true,
              }));
              return jsonResult({
                status: "ok" as const,
                workflows,
                allowlist_active: allowlistActive,
              });
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              return jsonResult({
                status: "error" as const,
                reason: "request_failed",
                message,
              });
            }
          },
        };
      },
      { name: "langgraph_list_workflows" },
    );

    // ---- 1d. Tool: langgraph_dispatch --------------------------------------
    api.registerTool(
      (toolContext) => {
        const sessionKey = toolContext.sessionKey;
        const baseUrl = config.langgraphBaseUrl;
        const timeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        const allowed = config.allowedWorkflows;
        const callbackPublic = config.callbackPublicBaseUrl;
        const langgraphApiKey = config.langgraphApiKey;
        const langgraphAuthScheme = config.langgraphAuthScheme;

        return {
          name: "langgraph_dispatch",
          label: "LangGraph Dispatch",
          description:
            "Dispatch a LangGraph workflow run. The plugin creates a managed TaskFlow bound to the current session, kicks the run, and returns identifiers. status / milestone / decision / terminal / hitl events post back via the plugin webhook and surface as runtime events on the originating session.\n\nIMPORTANT: `input` must match the target workflow's state schema exactly. LangGraph silently drops unknown keys, which can cause downstream KeyErrors. For the `fleet` workflow specifically, required keys are `ticket_id`, `repo`, and `spec_path` — where `spec_path` is a path to an existing spec file *already committed* in the repo (e.g. `feature/<ticket-id>/tech-spec.md`). Free-text descriptions are NOT a substitute. To inspect a workflow's schema: GET `<base>/assistants/<assistant_id>/schemas`.",
          // Note: when the wake fires for an event tied to a Slack-threaded
          // session, the wake message will include a `[reply-hint]` line
          // pointing at the originating thread — see
          // webhook-handler.ts#buildReplyHint. Honour it on outbound sends
          // so milestone/decision/terminal posts land in the right thread.
          parameters: DispatchParams,
          execute: async (_toolCallId: string, paramsUnknown: unknown, _signal?: AbortSignal) => {
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
                message: "langgraph_dispatch requires a session-bound tool context.",
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

            const client = new LanggraphClient({
              baseUrl,
              timeoutMs,
              apiKey: langgraphApiKey,
              authScheme: langgraphAuthScheme,
            });
            const decisionOnly = params.decision_only ?? true;
            const milestoneModel =
              typeof params.milestone_model === "string" && params.milestone_model.trim().length > 0
                ? params.milestone_model.trim()
                : undefined;
            const webhookUrl = callbackPublic
              ? callbackPublic.replace(/\/+$/, "") + WEBHOOK_PATH
              : undefined;

            // #7: Track the created flow outside the try block so the catch
            // can tombstone it if LangGraph dispatch fails, preventing a
            // permanent stale 'queued' flow that blocks inspect/resume.
            let pendingFlowId: string | undefined;
            let pendingFlowRevision: number | undefined;

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
                  milestone_model: milestoneModel ?? null,
                  langgraph_base_url: baseUrl,
                  webhook_url: webhookUrl ?? null,
                  phase: "phase-2-pre-langgraph-call",
                },
                currentStep: "dispatch:create-thread",
              });
              // Capture immediately so the catch block can tombstone on failure.
              pendingFlowId = flow.flowId;
              pendingFlowRevision = flow.revision;

              const threadId = await client.createThread({
                openclaw_flow_id: flow.flowId,
                openclaw_session_key: sessionKey,
              });

              // Phase 2 v3: atomic create+stream via POST /threads/{tid}/runs/stream.
              // No race window where a fast run can finish before we subscribe.
              // We get the run_id from the first SSE metadata frame and resolve
              // it back to the caller via a promise.
              let dispatchCtrl: AbortController | undefined;
              let ended = false;
              const runIdPromise = new Promise<string>((resolve, reject) => {
                const timer = setTimeout(() => {
                  if (ended) return;
                  ended = true;
                  if (dispatchCtrl) {
                    dispatchCtrl.abort();
                    _inflightControllers.delete(dispatchCtrl);
                  }
                  reject(new Error("timed out waiting for run_id metadata frame"));
                }, timeoutMs);
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
                dispatchCtrl = dispatchAndStream({
                  baseUrl,
                  threadId,
                  flowId: flow.flowId,
                  assistantId: params.workflow,
                  input: params.input ?? null,
                  apiKey: langgraphApiKey,
                  authScheme: langgraphAuthScheme,
                  // Security (#11): callbackToken is NEVER sent to LangGraph.
                  // It is used solely to authenticate inbound webhook POSTs
                  // from LangGraph (checked in webhook-handler.ts:buildHandler
                  // against the `Authorization: Bearer <token>` header).
                  // Verified: no token in URL path, query string, or metadata.
                  metadata: {
                    openclaw_flow_id: flow.flowId,
                    openclaw_session_key: sessionKey,
                    openclaw_decision_only: decisionOnly,
                  },
                  handlers: {
                    onRunId: (runId) => {
                      if (ended) return;
                      ended = true;
                      clearTimeout(timer);
                      // Do NOT remove from _inflightControllers here — stream is still alive.
                      resolve(runId);
                    },
                    onEvent,
                    onError: (err) => {
                      logger?.warn?.(
                        `langgraph-bridge: stream error flow=${flow.flowId}: ${err.message}`,
                      );
                      if (ended) return;
                      ended = true;
                      clearTimeout(timer);
                      if (dispatchCtrl) {
                        dispatchCtrl.abort();
                        _inflightControllers.delete(dispatchCtrl);
                      }
                      reject(err);
                    },
                    onClose: (sawTerminal) => {
                      logger?.info?.(
                        `langgraph-bridge: stream closed flow=${flow.flowId} sawTerminal=${sawTerminal}`,
                      );
                      if (dispatchCtrl) _inflightControllers.delete(dispatchCtrl);
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
                if (!ended && dispatchCtrl) {
                  _inflightControllers.add(dispatchCtrl);
                }
              });

              const runId = await runIdPromise;

              flows.resume({
                flowId: flow.flowId,
                expectedRevision: flow.revision,
                status: "running",
                stateJson: {
                  workflow: params.workflow,
                  decision_only: decisionOnly,
                  milestone_model: milestoneModel ?? null,
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
                milestone_model: milestoneModel ?? null,
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

              // #7: Tombstone the orphaned flow so langgraph_inspect doesn't
              // return a zombie 'queued' flow after a dispatch failure.
              // Wrapped in its own try/catch so cleanup failure never shadows
              // the original dispatch error being returned to the agent.
              if (pendingFlowId !== undefined) {
                try {
                  const cleanupFlows = handlerDeps.runtime.tasks.managedFlows.bindSession({
                    sessionKey,
                  });
                  // Re-read current revision in case processEvent already bumped
                  // it via runTask/setWaiting during stream setup.
                  const currentRecord = cleanupFlows.get(pendingFlowId) as
                    | { revision?: number }
                    | undefined;
                  const currentRevision = Number(
                    currentRecord?.revision ?? pendingFlowRevision ?? 0,
                  );
                  cleanupFlows.finish({
                    flowId: pendingFlowId,
                    expectedRevision: currentRevision,
                    stateJson: {
                      terminal_title: "dispatch_failed",
                      terminal_summary: message,
                    },
                    endedAt: Date.now(),
                  });
                  logger?.info?.(
                    `langgraph_dispatch: tombstoned orphaned flow=${pendingFlowId} after failure`,
                  );
                } catch {
                  // best-effort cleanup — don't shadow the original error
                }
              }

              return jsonResult({
                status: "error" as const,
                reason: "langgraph_dispatch_failed",
                message,
                http_status: err instanceof LanggraphHttpError ? err.status : undefined,
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

    // ---- 3. langgraph_resume tool ------------------------------------------
    // Resume an interrupted (waiting) flow with a payload. The agent
    // calls this tool when the human's reply means "continue the
    // workflow with this answer." Pivoted from a before_dispatch hook
    // because the runtime does not dispatch before_dispatch / inbound_claim
    // to this plugin for Slack DMs (confirmed empirically 2026-06-15:
    // hook registers but ENTER never fires). The tool path is the
    // documented, deterministic surface; we use that instead.
    api.registerTool(
      (toolContext) => {
        const sessionKey = toolContext.sessionKey;
        return {
          name: "langgraph_resume",
          label: "LangGraph Resume",
          description:
            "Resume a LangGraph workflow that is currently waiting at a HITL interrupt. Call this when the human's reply contains the answer that the workflow asked for (e.g., 'approve' for a merge_gate). With no flow_id, resumes the latest waiting flow in this session. The payload is whatever the workflow expects to satisfy the interrupt — a plain string works for most cases.",
          parameters: Type.Object({
            payload: Type.Unknown({
              description:
                "Resume payload. Usually the human's reply as a string. Can also be a structured object if the workflow expects one.",
            }),
            flow_id: Type.Optional(
              Type.String({
                description:
                  "Specific waiting flow to resume. Omit to resume the latest waiting flow in this session.",
              }),
            ),
          }),
          execute: async (_toolCallId: string, paramsUnknown: unknown) => {
            const params = paramsUnknown as {
              payload: unknown;
              flow_id?: string;
            };
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
              const candidate = params.flow_id
                ? (flows.get(params.flow_id) as unknown as
                    | {
                        flowId?: string;
                        status?: string;
                        revision?: number;
                        stateJson?: Record<string, unknown> | string | null;
                        waitJson?: Record<string, unknown> | string | null;
                      }
                    | undefined)
                : (flows.findLatest() as unknown as
                    | {
                        flowId?: string;
                        status?: string;
                        revision?: number;
                        stateJson?: Record<string, unknown> | string | null;
                        waitJson?: Record<string, unknown> | string | null;
                      }
                    | undefined);
              if (!candidate) {
                return jsonResult({
                  status: "error" as const,
                  reason: "no_flow_found",
                  message:
                    "No matching flow found in this session. Did the workflow finish or fail?",
                });
              }
              if (candidate.status !== "waiting") {
                return jsonResult({
                  status: "error" as const,
                  reason: "flow_not_waiting",
                  message: `Flow ${candidate.flowId} is currently ${candidate.status}, not waiting. Nothing to resume.`,
                  flow_id: candidate.flowId,
                  current_status: candidate.status,
                });
              }
              const flowId = candidate.flowId!;
              if (resumeInProgress.has(flowId)) {
                return jsonResult({
                  status: "error" as const,
                  reason: "resume_already_in_progress",
                  message: `Flow ${flowId} already has a resume in flight. Wait for it to complete (you'll be woken when the resumed run emits its next event) or call langgraph_inspect to check current status.`,
                  flow_id: flowId,
                });
              }
              resumeInProgress.add(flowId);
              try {
                const stateJson = parseMaybeJson(candidate.stateJson) ?? {};
                const threadId = stateJson.langgraph_thread_id as string | undefined;
                const workflow = stateJson.workflow as string | undefined;
                const baseUrl =
                  (stateJson.langgraph_base_url as string | undefined) ?? config.langgraphBaseUrl;
                if (!threadId || !workflow || !baseUrl) {
                  return jsonResult({
                    status: "error" as const,
                    reason: "flow_state_missing_handles",
                    message:
                      "Flow state is missing langgraph_thread_id / workflow / base_url; cannot resume.",
                    flow_id: candidate.flowId,
                  });
                }

                // Normalize common HITL string responses into the structured
                // {decision, feedback} shape most workflows' gate parsers
                // accept. Plain strings still pass through unchanged for
                // workflows whose interrupts expect a raw string.
                const normalizedPayload = normalizeResumePayload(params.payload);

                // Phase 5 (2026-06-16): resume via streaming endpoint, not
                // fire-and-forget. Previously called client.resumeRun which
                // POSTed /threads/{tid}/runs and returned the run_id. That
                // worked, but no SSE subscriber was opened on the new run,
                // so any milestone / hitl / terminal events emitted by the
                // resumed graph never reached our processEvent pipeline and
                // never woke the agent. Symptom: resume merged on
                // LangGraph but the agent was never woken about the terminal.
                //
                // Fix: route resume through dispatchAndStream with `command`
                // instead of `input`. Identical subscriber lifecycle to
                // initial dispatch — same processEvent, same wakeAgent.
                const timeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
                const langgraphApiKey = config.langgraphApiKey;
                const langgraphAuthScheme = config.langgraphAuthScheme;
                const flowRevisionForSubscriber = Number(candidate.revision ?? 0);
                const onEvent = (body: IncomingEventBody) => {
                  try {
                    processEvent({
                      body,
                      sessionKey,
                      flowRevision: flowRevisionForSubscriber,
                      deps: handlerDeps,
                    });
                  } catch (err: unknown) {
                    const m = err instanceof Error ? err.message : String(err);
                    logger?.warn?.(
                      `langgraph-bridge: resume subscriber processEvent failed flow=${candidate.flowId}: ${m}`,
                    );
                  }
                };
                let resumeCtrl: AbortController | undefined;
                let resumeEnded = false;
                const runIdPromise = new Promise<string>((resolve, reject) => {
                  const timer = setTimeout(() => {
                    if (resumeEnded) return;
                    resumeEnded = true;
                    if (resumeCtrl) {
                      resumeCtrl.abort();
                      _inflightControllers.delete(resumeCtrl);
                    }
                    reject(new Error("timed out waiting for resume run_id metadata frame"));
                  }, timeoutMs);
                  resumeCtrl = dispatchAndStream({
                    baseUrl,
                    threadId,
                    flowId: candidate.flowId!,
                    assistantId: workflow,
                    command: { resume: normalizedPayload },
                    apiKey: langgraphApiKey,
                    authScheme: langgraphAuthScheme,
                    metadata: {
                      openclaw_flow_id: candidate.flowId,
                      openclaw_session_key: sessionKey,
                      openclaw_resume_source: "tool:langgraph_resume",
                    },
                    handlers: {
                      onRunId: (runId) => {
                        if (resumeEnded) return;
                        resumeEnded = true;
                        clearTimeout(timer);
                        // Do NOT remove from _inflightControllers here — stream is still alive.
                        resolve(runId);
                      },
                      onEvent,
                      onError: (err) => {
                        logger?.warn?.(
                          `langgraph-bridge: resume stream error flow=${candidate.flowId}: ${err.message}`,
                        );
                        if (resumeEnded) return;
                        resumeEnded = true;
                        clearTimeout(timer);
                        if (resumeCtrl) {
                          resumeCtrl.abort();
                          _inflightControllers.delete(resumeCtrl);
                        }
                        reject(err);
                      },
                      onClose: (sawTerminal) => {
                        logger?.info?.(
                          `langgraph-bridge: resume stream closed flow=${candidate.flowId} sawTerminal=${sawTerminal}`,
                        );
                        if (resumeCtrl) _inflightControllers.delete(resumeCtrl);
                        // Same synthetic-terminal fallback as initial dispatch:
                        // if the resumed run ended without a terminal-kind
                        // event, fabricate one so the agent learns the run
                        // finished. Real terminal and hitl events suppress
                        // this branch.
                        if (!sawTerminal) {
                          try {
                            processEvent({
                              body: {
                                kind: "terminal",
                                flow_id: candidate.flowId!,
                                title: "graph:end",
                                summary: "workflow completed (no error)",
                              },
                              sessionKey,
                              flowRevision: flowRevisionForSubscriber,
                              deps: handlerDeps,
                            });
                          } catch {
                            // Best-effort — if processEvent throws, fall
                            // through; we already logged the close.
                          }
                        }
                      },
                    },
                  });
                  if (!resumeEnded && resumeCtrl) {
                    _inflightControllers.add(resumeCtrl);
                  }
                });
                const resumeRunId = await runIdPromise;

                // Transition flow waiting -> running. Re-read current revision.
                const liveFlow = flows.get(candidate.flowId!) as { revision?: number } | undefined;
                const liveRevision = Number(liveFlow?.revision ?? candidate.revision ?? 0);
                flows.resume({
                  flowId: candidate.flowId!,
                  expectedRevision: liveRevision,
                  status: "running",
                  currentStep: "resumed",
                  stateJson: {
                    ...stateJson,
                    phase: "phase-5-resumed-stream",
                    resume_payload_preview:
                      typeof normalizedPayload === "string"
                        ? normalizedPayload.slice(0, 200)
                        : JSON.stringify(normalizedPayload).slice(0, 200),
                    resumed_at: Date.now(),
                    resume_run_id: resumeRunId,
                  },
                });

                logger?.info?.(
                  `langgraph_resume: resumed flow=${candidate.flowId} thread=${threadId} new_run=${resumeRunId} (streaming)`,
                );

                return jsonResult({
                  status: "resumed" as const,
                  flow_id: candidate.flowId,
                  langgraph_thread_id: threadId,
                  resume_run_id: resumeRunId,
                  note: "Flow is back to running and SSE subscriber is attached. Subsequent events will surface in this session as they fire.",
                });
              } finally {
                resumeInProgress.delete(flowId);
              }
            } catch (err: unknown) {
              const m = err instanceof Error ? err.message : String(err);
              logger?.error?.(`langgraph_resume failed: ${m}`);
              return jsonResult({
                status: "error" as const,
                reason: "resume_failed",
                message: m,
              });
            }
          },
        };
      },
      { name: "langgraph_resume" },
    );

    // ---- 4. (removed) before_dispatch / inbound_claim auto-resume hook -----
    // Earlier iterations tried both `before_dispatch` and `inbound_claim` hooks
    // to auto-resume HITL flows when the human replied. Both proved empirically
    // flaky on this gateway's Slack DM path. The pivot: an explicit
    // `langgraph_resume` tool the agent calls when it has a confirmed reply.
    // See the `langgraph_resume` registration above (the documented,
    // deterministic path) for the current implementation. Removed from
    // `src/index.ts` in chore: remove dead before_dispatch hook block (#69 S1).

    logger?.info?.(
      `openclaw-langgraph-bridge: registered POST ${WEBHOOK_PATH} + langgraph_dispatch + langgraph_inspect + langgraph_inspect_workflow + langgraph_list_workflows + langgraph_resume tools (token configured: ${Boolean(config.callbackToken)})`,
    );
  },
});

// ---------------------------------------------------------------------------
// Module-level constants (hoisted to avoid per-call allocations)
// ---------------------------------------------------------------------------

/** Recognized HITL approve keywords for normalizeResumePayload. */
const RESUME_APPROVE = new Set(["approve", "approved", "yes", "ok", "lgtm"]);
/** Recognized HITL block-and-revise keywords for normalizeResumePayload. */
const RESUME_BLOCK_REVISE = new Set(["block", "block_revise", "revise", "no"]);
/** Recognized HITL block-and-abort keywords for normalizeResumePayload. */
const RESUME_BLOCK_ABORT = new Set(["block_abort", "abort", "stop", "end", "cancel"]);
/** Recognized HITL extend keywords for normalizeResumePayload. */
const RESUME_EXTEND = new Set(["extend", "extend_cap", "continue"]);

/**
 * Normalize a resume payload so common HITL replies route cleanly through
 * gate parsers that expect a structured response. Accepts:
 *   - bare "approve" / "block_revise" / "block_abort" / "extend" / "abort"
 *     -> {decision: <normalized>, feedback: ""}
 *   - "block_revise: <feedback>" or "block: <feedback>"
 *     -> {decision: "block_revise", feedback: "<feedback>"}
 *   - anything else (other strings, objects, numbers): pass through
 *     unchanged so workflows whose interrupts expect raw payloads still work
 *
 * Aliases match the typical merge_gate / design_gate parser shape used in
 * langgraph workflows (see `<your-org>/your-langgraph-workflows` `graph/workflow.py`).
 */
export function normalizeResumePayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  const trimmed = payload.trim();
  if (!trimmed) return payload;

  // Split "<decision>: <feedback>" if present
  const colonIdx = trimmed.indexOf(":");
  let decisionRaw: string;
  let feedback = "";
  if (colonIdx !== -1) {
    decisionRaw = trimmed.slice(0, colonIdx).trim();
    feedback = trimmed.slice(colonIdx + 1).trim();
  } else {
    decisionRaw = trimmed;
  }
  const lower = decisionRaw.toLowerCase();

  let decision: string | null = null;
  if (RESUME_APPROVE.has(lower)) decision = "approve";
  else if (RESUME_BLOCK_REVISE.has(lower)) decision = "block_revise";
  else if (RESUME_BLOCK_ABORT.has(lower)) decision = "block_abort";
  else if (RESUME_EXTEND.has(lower)) decision = "extend";

  // Not a recognized HITL keyword -> pass raw string through
  if (decision === null) return payload;

  return { decision, feedback };
}

export default entry;
