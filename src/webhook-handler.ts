/**
 * Phase 2 — Webhook handler.
 *
 * Receives event POSTs from a LangGraph workflow and routes them into the
 * originating OpenClaw session via managedFlows + (optionally)
 * enqueueSystemEvent + requestHeartbeat.
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

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  actionHeartbeatReason,
  actionRequiresWake,
  classifyEvent,
  type LanggraphEventKind,
} from "./event-classifier.js";

const MAX_BODY_BYTES = 64 * 1024;

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
    system: {
      enqueueSystemEvent: (
        text: string,
        opts: {
          sessionKey: string;
          contextKey?: string | null;
        },
      ) => boolean;
      requestHeartbeat: (opts: {
        source: "hook" | "other" | "background-task";
        intent: "event" | "scheduled" | "immediate" | "manual";
        reason?: string;
        sessionKey?: string;
        coalesceMs?: number;
      }) => void;
    };
  };
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
    | { revision?: number }
    | undefined;
  const flowRevision = Number(currentFlow?.revision ?? params.flowRevision ?? 0);
  const classification = classifyEvent({ kind });
  const title = body.title ?? `langgraph:${kind}`;
  const summary = (body.summary ?? "").slice(0, 280);

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

  // 2. Emit a system event into the session queue. Always — even for
  //    status events. Status events get a shared contextKey so the queue
  //    dedups runs of the same event-kind without growing unbounded; the
  //    agent will see the most recent status entry whenever it next wakes
  //    for some other reason.
  const eventText = formatEventText(kind, title, summary);
  const contextKey =
    classification.contextKeyHint === "noise"
      ? `langgraph:${body.flow_id}:status`
      : null;
  deps.runtime.system.enqueueSystemEvent(eventText, {
    sessionKey,
    contextKey,
  });

  // 3. Decide whether to wake the agent.
  if (actionRequiresWake(classification.action)) {
    deps.runtime.system.requestHeartbeat({
      source: "hook" as const,
      intent: "event" as const,
      reason: actionHeartbeatReason(classification.action),
      sessionKey,
      // Light coalesce so a burst of milestones doesn't fire N turns.
      coalesceMs: 500,
    });
  }

  deps.logger?.info?.(
    `langgraph-bridge: routed flow=${body.flow_id} kind=${kind} action=${classification.action}`,
  );

  return { status: "ok", action: classification.action };
}

function formatEventText(
  kind: LanggraphEventKind,
  title: string,
  summary: string,
): string {
  const head = `[langgraph:${kind}] ${title}`;
  if (!summary) return head;
  return `${head}\n${summary}`;
}

/**
 * Build the actual HTTP route handler. Captures `deps` in a closure so the
 * handler matches the OpenClawPluginHttpRouteHandler signature
 * (req, res) -> Promise<void>.
 */
export function buildHandler(deps: WebhookHandlerDeps) {
  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
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
      if (presented !== deps.expectedToken) {
        deps.logger?.warn?.("langgraph-bridge: unauthorized webhook POST");
        reply(res, 401, { error: "unauthorized" });
        return;
      }
    } else {
      // No token configured — refuse rather than allow open ingress.
      deps.logger?.warn?.(
        "langgraph-bridge: no callbackToken configured; refusing webhook",
      );
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
function lookupFlow(
  deps: WebhookHandlerDeps,
  flowId: string,
): Record<string, unknown> | undefined {
  // Bind with a placeholder sessionKey — read-only get() is unaffected
  // by which session is bound.
  const binding = deps.runtime.tasks.managedFlows.bindSession({
    sessionKey: "system:plugin:langgraph-bridge:lookup",
  });
  return binding.get(flowId);
}

function reply(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

async function readBodyWithLimit(
  req: IncomingMessage,
  limitBytes: number,
): Promise<string> {
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
