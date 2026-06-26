/**
 * Phase 2/4 — Webhook handler.
 *
 * Receives event POSTs from a LangGraph workflow and routes them into the
 * originating OpenClaw session via managedFlows + (Phase 4) the
 * `openclaw agent` CLI wake primitive.
 *
 * Phase 4 changes (2026-06-16):
 *   - Dropped `enqueueSystemEvent` and `requestHeartbeat` from the wake
 *     path. `requestHeartbeat` does not fire for Slack-DM Anthropic-
 *     provider sessions; the system-event queue alone never woke the
 *     agent without an external wake. Empirically confirmed via
 *     gateway.log (zero `[heartbeat]` dispatches) in late-night dig
 *     2026-06-15 — validated empirically via gateway.log analysis.
 *   - Replaced with `wakeAgent()` from ./wake-agent, which shells out
 *     to `openclaw agent --agent <id> --session-key <key> --message`.
 *   - Agent id is plumbed via `deps.agentId` (sourced from
 *     plugin-config `agentId`, default "main").
 *
 * Wire shape: the workflow posts JSON like
 *
 *   {
 *     "kind": "status" | "milestone" | "decision" | "terminal" | "hitl",
 *     "flow_id": "<openclaw_flow_id from dispatch>",
 *     "seq": 7,                              // monotonic per run
 *     "title": "node:coder",                 // short, machine-readable
 *     "summary": "<= 280 chars human text",
 *     "data": { ... }                        // anything; kept for inspect
 *   }
 *
 * Auth: `Authorization: Bearer <callbackToken>` from plugin config.
 *
 * This module owns the request-handling shape and the SDK glue. The
 * routing decision lives in event-classifier.ts to keep it cheap to test.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { actionRequiresWake, classifyEvent, type LanggraphEventKind } from "./event-classifier.js";
import { wakeAgentAsync } from "./wake-agent.js";
import { enqueueWake as enqueueWakeDefault } from "./wake-queue.js";
import { truncateSummary } from "./text-utils.js";
import type { WakeBudget } from "./wake-budget.js";
import type { WakeDedup } from "./wake-dedup.js";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Per-flow cache of `milestone_model` values the gateway has already
 * rejected. After the first rejection (handled by `wake-agent.ts`'s
 * graceful-degradation retry), subsequent milestone wakes for the same
 * flow skip the override entirely — no point paying the failure +
 * retry cost on every event.
 *
 * Process-local; not persisted. Bridge restarts re-validate on the
 * next wake. Cache entries are GC'd on terminal events. Different
 * flows with the same bad model each pay the rejection cost once.
 */
const invalidMilestoneModelFlows = new Set<string>();

/** Test-only helper for resetting the cache between cases. */
export function __resetInvalidMilestoneModelFlowsForTest(): void {
  invalidMilestoneModelFlows.clear();
}

// Terminal task-flow statuses per OpenClaw SDK `TaskFlowStatus`:
//   "queued" | "running" | "waiting" | "blocked" | "succeeded" | "failed"
//   | "cancelled" | "lost"
// The last four are terminal — the flow will not transition out of them.
// Hoisted module-level (vs per-call new Set) so the guard in processEvent
// is allocation-free on every webhook event.
const TERMINAL_FLOW_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "lost",
]);

const VALID_KINDS: ReadonlySet<LanggraphEventKind> = new Set([
  "status",
  "milestone",
  "decision",
  "terminal",
  "hitl",
] as const);

export type WebhookHandlerDeps = {
  expectedToken: string | undefined;
  /** Plugin id, used for managedFlows.bindSession requesterOrigin. */
  pluginId: string;
  /**
   * Agent id to wake when an event requires waking. Sourced from
   * plugin config `agentId` (default "main").
   */
  agentId: string;
  /** Runtime surface from api.runtime. */
  runtime: {
    tasks: {
      managedFlows: {
        bindSession: (params: { sessionKey: string }) => {
          get: (flowId: string) => Record<string, unknown> | undefined;
          runTask: (params: Record<string, unknown>) => unknown;
          setWaiting: (params: Record<string, unknown>) => unknown;
          finish: (params: Record<string, unknown>) => unknown;
        };
      };
    };
  };
  /**
   * Override the async wake function. Defaults to the real
   * `wakeAgentAsync`. Used in tests to assert calls without shelling out.
   * The return type is `void | Promise<void>` so that synchronous vi.fn()
   * mocks remain compatible in unit tests that don't need to test the
   * queue ordering behaviour.
   */
  wake?: (
    params: Parameters<typeof wakeAgentAsync>[0],
    deps?: Parameters<typeof wakeAgentAsync>[1],
  ) => void | Promise<void>;
  /**
   * Override the queue enqueue function. Defaults to the real
   * `enqueueWake` from wake-queue.ts. Inject a synchronous version in
   * unit tests that want immediate (non-deferred) wake delivery so that
   * existing assertions on `deps.wake` don't need to await queue drain.
   */
  enqueueWake?: (sessionKey: string, run: () => Promise<void>) => void;
  /**
   * Maximum characters for the summary field in wake messages. When a
   * body.summary exceeds this cap the text is truncated at the last
   * ASCII space (0x20) and a ` …[truncated]` marker is appended.
   * Other whitespace (newlines, tabs) is not treated as a cut point.
   * Defaults to
   * 4000. Configurable via plugin config `summaryMaxChars`.
   */
  summaryMaxChars?: number;
  /**
   * Per-flow sliding-window wake budget (Phase 1, issue #91).
   * When set, milestone wakes that exceed the cap are coalesced into a
   * single trailing-edge wake at the end of the rolling window.
   * If unset, no budget is enforced.
   */
  wakeBudget?: WakeBudget;
  /**
   * Same-key milestone dedup + fanout collapse (Phase 2, issue #91).
   * When set, same-key milestone repeats and concurrent "finished" keys
   * are coalesced into trailing-edge wakes instead of waking immediately.
   * If unset, every milestone fires immediately (legacy behaviour).
   */
  wakeDedup?: WakeDedup;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
};

export type IncomingEventBody = {
  kind: string;
  flow_id: string;
  seq?: number;
  title?: string;
  summary?: string;
  data?: Record<string, unknown>;
  interrupt_id?: string;
};

/**
 * Pure function that does the routing work given a *parsed* event body
 * and a session key resolved from the bound flow. Split out from the
 * HTTP handler so it can be unit-tested without a real `req`/`res`.
 */
export function processEvent(params: {
  body: IncomingEventBody;
  sessionKey: string;
  /**
   * Optional starting revision hint. When provided, we still re-read the
   * flow's current revision before issuing a mutation so we never lose
   * a setWaiting/finish call to a revision_conflict. Phase 2 v3 (SSE)
   * passes the initial revision captured at createManaged, but mutations
   * land long after resume() has bumped revision; ignoring the hint and
   * re-reading is the safe path.
   */
  flowRevision?: number;
  deps: WebhookHandlerDeps;
}): { status: "ok"; action: string } {
  const { body, sessionKey, deps } = params;
  const kind = body.kind as LanggraphEventKind;

  const flows = deps.runtime.tasks.managedFlows.bindSession({ sessionKey });

  // Always re-read the current revision before issuing a mutation that
  // takes expectedRevision. The flow likely moved through createManaged
  // -> resume(running) -> ... by the time we get here.
  const currentFlow = flows.get(body.flow_id) as
    | { revision?: number; status?: string; stateJson?: unknown }
    | undefined;
  const flowRevision = Number(currentFlow?.revision ?? params.flowRevision ?? 0);

  // #6: Read decision_only from flow stateJson. When true (the default),
  // milestone events update flow state silently but do NOT wake the agent.
  // When false, all wake-emitting events (milestone, decision, hitl, terminal)
  // wake the agent. Stored during dispatch as stateJson.decision_only.
  const rawStateJson = currentFlow?.stateJson;
  const parsedStateJson: Record<string, unknown> | null =
    rawStateJson && typeof rawStateJson === "object"
      ? (rawStateJson as Record<string, unknown>)
      : rawStateJson && typeof rawStateJson === "string"
        ? (() => {
            try {
              const p: unknown = JSON.parse(rawStateJson as string);
              return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
            } catch {
              return null;
            }
          })()
        : null;
  // Default true: matches the parameter default in DispatchParams and the
  // original docstring promise ("when true, only decision/hitl/terminal wake").
  const decisionOnly: boolean = parsedStateJson?.decision_only !== false;

  // Optional `--model` override for milestone wakes only. Persisted at
  // dispatch time as stateJson.milestone_model (string or null). When
  // present, the webhook handler passes it to `wakeAgentAsync` for
  // milestone events; decision/hitl/terminal wakes always use the
  // session's primary model and ignore this. See #83.
  const rawMilestoneModel = parsedStateJson?.milestone_model;
  const milestoneModel: string | undefined =
    typeof rawMilestoneModel === "string" && rawMilestoneModel.trim().length > 0
      ? rawMilestoneModel.trim()
      : undefined;

  // Defense in depth (#10 / #16): if the flow is already in a terminal
  // state, ignore replay frames — LangGraph's stream + webhook can
  // deliver the same kind twice or replay HITL/recap frames out of
  // causal order after `graph:end`. We must NOT call `setWaiting` /
  // `finish` / `runTask` against a terminated flow:
  //   - `setWaiting` on a terminated flow corrupts its status from
  //     `succeeded` -> `waiting`, which causes any consumer following
  //     `inspect`->`resume` to double-fire `langgraph_resume` into an
  //     already-completed flow (#16).
  //   - `finish` on an already-finished flow throws a revision
  //     conflict, propagates up to a 500 in `buildHandler`, which
  //     LangGraph treats as retryable (#10).
  //   - `runTask` for status/milestone after terminal records spurious
  //     post-terminal task progress entries, which mislead an operator
  //     reading flow history.
  //
  // We also suppress the wake path on terminated flows so we don't fire
  // a stale agent turn for a flow the consumer already saw close.
  const flowAlreadyTerminated =
    typeof currentFlow?.status === "string" && TERMINAL_FLOW_STATUSES.has(currentFlow.status);
  if (flowAlreadyTerminated) {
    deps.logger?.info?.(
      `langgraph-bridge: ignoring stale ${kind} for terminated flow=${body.flow_id} status=${currentFlow?.status}`,
    );
    return { status: "ok", action: "ignored:post-terminal" };
  }

  const classification = classifyEvent({ kind });
  const title = body.title ?? `langgraph:${kind}`;
  // Configurable summary cap — defaults to 4000 chars. See ./text-utils.
  const summary = truncateSummary(body.summary ?? "", deps.summaryMaxChars);

  // 1. Always update flow state. The shape of the update depends on kind.
  switch (kind) {
    case "status":
    case "milestone":
      flows.runTask({
        flowId: body.flow_id,
        runtime: "subagent" as const,
        childSessionKey: `${sessionKey}:flow:${body.flow_id}:seq:${body.seq ?? "unset"}`,
        task: title,
        status: "completed",
        startedAt: Date.now(),
        lastEventAt: Date.now(),
        progressSummary: summary || null,
      });
      break;
    case "hitl":
      flows.setWaiting({
        flowId: body.flow_id,
        expectedRevision: flowRevision,
        currentStep: title,
        waitJson: {
          kind: "langgraph_interrupt",
          interrupt_id: body.interrupt_id ?? null,
          prompt: summary,
          received_at: Date.now(),
        },
      });
      break;
    case "decision":
      // No structural flow change; just an event surfaced to the agent.
      // We don't move into "waiting" because the agent decides freely,
      // not against a langgraph interrupt.
      break;
    case "terminal":
      flows.finish({
        flowId: body.flow_id,
        expectedRevision: flowRevision,
        stateJson: {
          terminal_title: title,
          terminal_summary: summary,
          data: body.data ?? null,
        },
        endedAt: Date.now(),
      });
      break;
  }

  // 2. Decide whether to wake the agent. Phase 4: wake via the
  //    `openclaw agent` CLI primitive (the only thing confirmed to wake
  //    a Slack-DM Anthropic session). Status events still pass through
  //    flow state but emit no wake and no system event — they're
  //    intentionally silent. The agent will see the latest flow state
  //    whenever it next turns for any other reason.
  //
  //    #6: decision_only=true (default) suppresses wakes for `milestone`
  //    events only — they still update flow state (runTask above) but the
  //    agent is not woken. decision_only=false restores milestone wakes.
  //    decision/hitl/terminal always wake regardless of this flag.
  if (actionRequiresWake(classification.action)) {
    const isWakeSuppressed = decisionOnly && classification.action === "wake-light";
    if (isWakeSuppressed) {
      deps.logger?.info?.(
        `langgraph-bridge: decision_only=true suppressing milestone wake flow=${body.flow_id}`,
      );
    } else {
      const doEnqueue = deps.enqueueWake ?? enqueueWakeDefault;
      const wakeImpl = deps.wake ?? wakeAgentAsync;
      const wakeMessage = formatEventText(kind, title, summary, sessionKey);

      // Only forward `milestone_model` for milestone events. Decision /
      // HITL / terminal wakes always use the session's primary model so
      // reply quality stays high where it matters most. Skip the
      // override if the gateway already rejected it for this flow
      // (set by the `onInvalidModel` callback below).
      const isMilestone = classification.action === "wake-light";
      const modelForThisWake =
        isMilestone && milestoneModel && !invalidMilestoneModelFlows.has(body.flow_id)
          ? milestoneModel
          : undefined;

      const onInvalidModel = isMilestone
        ? ({ model, cliError }: { model: string; cliError: string }) => {
            // First rejection for this flow: cache it so subsequent
            // milestone wakes skip the override entirely. The retry
            // without `--model` is handled inside `wakeAgentAsync`; we
            // just need to ensure NEXT events don't repeat the cycle.
            if (!invalidMilestoneModelFlows.has(body.flow_id)) {
              invalidMilestoneModelFlows.add(body.flow_id);
              deps.logger?.warn?.(
                `langgraph-bridge: caching milestone_model rejection flow=${body.flow_id} model=${model} — future milestone wakes for this flow will skip the override. CLI: ${cliError.slice(0, 200)}`,
              );
            }
          }
        : undefined;

      // Helper: perform the actual wake enqueue. Used both for immediate
      // wakes and as the trailing-edge callback for dedup/budget.
      const fireWake = () => {
        doEnqueue(sessionKey, () =>
          Promise.resolve(
            wakeImpl(
              {
                agentId: deps.agentId,
                sessionKey,
                message: wakeMessage,
                model: modelForThisWake,
              },
              { logger: deps.logger, onInvalidModel },
            ),
          ),
        );
      };

      // ── Phase 2: same-key dedup + fanout collapse (milestone only) ──
      // decision / hitl / terminal are never deduped — they always reach
      // fireWake. Only wake-light (milestone) goes through the dedup gate.
      if (isMilestone && deps.wakeDedup != null) {
        const shouldWakeNow = deps.wakeDedup.shouldWakeNow(body, fireWake);
        if (!shouldWakeNow) {
          deps.logger?.info?.(
            `langgraph-bridge: dedup suppressed immediate milestone wake flow=${body.flow_id} title=${title}`,
          );
          // fireWake registered as trailing callback; return early.
          // The budget is not charged here — trailing edge fires later
          // and will be checked by budget at that point (budget is applied
          // AFTER dedup, so only unsuppressed wakes count).
          // (Budget is only wired for immediate wakes; trailing-edge
          // callbacks bypass budget intentionally — they represent the
          // consolidated summary, not a new event.)
          return { status: "ok", action: `${classification.action}:dedup-deferred` };
        }
      }

      // ── Phase 1: per-flow wake budget (milestone only) ──────────────
      // Checked AFTER dedup so only unsuppressed wakes count against the
      // budget. decision / hitl / terminal bypass the budget entirely.
      if (isMilestone && deps.wakeBudget != null) {
        const withinBudget = deps.wakeBudget.checkBudget(body.flow_id, fireWake);
        if (!withinBudget) {
          deps.logger?.info?.(
            `langgraph-bridge: budget exceeded for flow=${body.flow_id}; trailing-edge wake scheduled`,
          );
          return { status: "ok", action: `${classification.action}:budget-deferred` };
        }
      }

      fireWake();
    }
  }

  // GC per-flow state on terminal. The flow won't see more milestone events
  // after this, so holding per-flow entries forever would leak.
  if (kind === "terminal") {
    invalidMilestoneModelFlows.delete(body.flow_id);
    // Prune wake-budget entry (cancels any pending trailing-edge timer).
    deps.wakeBudget?.pruneFlow(body.flow_id);
  }

  deps.logger?.info?.(
    `langgraph-bridge: routed flow=${body.flow_id} kind=${kind} action=${classification.action}`,
  );

  return { status: "ok", action: classification.action };
}

/**
 * Build the system-event text delivered to the agent when a wake fires.
 *
 * Includes a thread/chat hint extracted from `sessionKey` (if present) so
 * the agent knows where to reply. Without this, woken agents default to
 * the session's root channel rather than the originating thread — the
 * `openclaw agent` CLI has no `--thread-id` flag and the runtime doesn't
 * synthesize chat context from the session key on its own.
 *
 * SessionKey shapes we recognize:
 *   agent:<id>:slack:channel:<chlower>:thread:<ts>     → Slack threaded
 *   agent:<id>:slack:dm:<user>                         → Slack DM (no hint)
 *   agent:<id>:<other>:…                                → unrecognized, no hint
 */
export function formatEventText(
  kind: LanggraphEventKind,
  title: string,
  summary: string,
  sessionKey?: string,
): string {
  const head = `[langgraph:${kind}] ${title}`;
  const hint = sessionKey ? buildReplyHint(sessionKey) : "";
  const lines: string[] = [];
  if (hint) lines.push(hint);
  lines.push(head);
  if (summary) lines.push(summary);
  return lines.join("\n");
}

/**
 * Extract a human-readable reply hint from a session key. Returns an empty
 * string when no hint is appropriate (e.g. plain DMs).
 */
export function buildReplyHint(sessionKey: string): string {
  // Slack threaded channel session: agent:<id>:slack:channel:<ch>:thread:<ts>
  const slackThread = sessionKey.match(/:slack:channel:([^:]+):thread:([^:]+)/i);
  if (slackThread) {
    const [, channel, ts] = slackThread;
    return `[reply-hint] This wake was bound to a Slack thread. Reply IN-THREAD by passing threadId="${ts}" on your next message tool call (channel=${channel}). Default outbound otherwise lands at channel root.`;
  }
  return "";
}

/**
 * Build the actual HTTP route handler. Captures `deps` in a closure so the
 * handler matches the OpenClawPluginHttpRouteHandler signature
 * (req, res) -> Promise<void>.
 */

/**
 * Constant-time string comparison using `crypto.timingSafeEqual`.
 *
 * Both strings are encoded to UTF-8 before comparison. Returns `false`
 * immediately when lengths differ (length-leak is acceptable per the
 * security review; the secret token has a fixed format).
 */
export function safeCompare(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buildHandler(deps: WebhookHandlerDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      reply(res, 405, { error: "method_not_allowed" });
      return;
    }

    // Auth: bearer token compared to the configured callbackToken.
    if (deps.expectedToken) {
      const auth = req.headers["authorization"];
      const presented =
        typeof auth === "string" && auth.startsWith("Bearer ")
          ? auth.slice("Bearer ".length)
          : undefined;
      if (!safeCompare(presented ?? "", deps.expectedToken)) {
        deps.logger?.warn?.("langgraph-bridge: unauthorized webhook POST");
        reply(res, 401, { error: "unauthorized" });
        return;
      }
    } else {
      // No token configured — refuse rather than allow open ingress.
      deps.logger?.warn?.("langgraph-bridge: no callbackToken configured; refusing webhook");
      reply(res, 503, { error: "callback_token_not_configured" });
      return;
    }

    let raw: string;
    try {
      raw = await readBodyWithLimit(req, MAX_BODY_BYTES);
    } catch (err) {
      reply(res, 413, {
        error: "body_too_large_or_unreadable",
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let body: IncomingEventBody;
    try {
      body = JSON.parse(raw) as IncomingEventBody;
    } catch {
      reply(res, 400, { error: "invalid_json" });
      return;
    }

    if (!body || typeof body !== "object") {
      reply(res, 400, { error: "body_not_object" });
      return;
    }
    if (typeof body.flow_id !== "string" || body.flow_id.length === 0) {
      reply(res, 400, { error: "missing_flow_id" });
      return;
    }
    if (!VALID_KINDS.has(body.kind as LanggraphEventKind)) {
      reply(res, 400, {
        error: "invalid_kind",
        kind: body.kind,
        allowed: Array.from(VALID_KINDS),
      });
      return;
    }

    // Resolve the bound session key from the flow itself.
    // We don't trust the inbound to tell us the session key — we look it
    // up server-side via the flow's owner_key.
    const flowRecord = lookupFlow(deps, body.flow_id);
    if (!flowRecord) {
      reply(res, 404, { error: "flow_not_found", flow_id: body.flow_id });
      return;
    }
    const sessionKey = String(flowRecord.owner_key ?? "");
    if (!sessionKey) {
      reply(res, 409, { error: "flow_missing_owner_key" });
      return;
    }
    const flowRevision = Number(flowRecord.revision ?? 0);

    try {
      const result = processEvent({
        body,
        sessionKey,
        flowRevision,
        deps,
      });
      reply(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger?.error?.(`langgraph-bridge: routing failed: ${message}`);
      reply(res, 500, { error: "routing_failed", message });
    }
  };
}

/**
 * Look up the managed flow record. We don't have a global "get without
 * binding a session" surface, so we go through bindSession with a
 * sentinel session key — bindSession just narrows future writes; the
 * read returned by get() is the full record either way.
 *
 * IMPORTANT: the FlowRecord includes owner_key + revision; both are read
 * from there to feed processEvent.
 */
function lookupFlow(deps: WebhookHandlerDeps, flowId: string): Record<string, unknown> | undefined {
  // Bind with a placeholder sessionKey — read-only get() is unaffected
  // by which session is bound.
  const binding = deps.runtime.tasks.managedFlows.bindSession({
    sessionKey: "system:plugin:langgraph-bridge:lookup",
  });
  return binding.get(flowId);
}

function reply(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

async function readBodyWithLimit(req: IncomingMessage, limitBytes: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > limitBytes) {
        reject(new Error(`body exceeded ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err: Error) => reject(err));
  });
}
