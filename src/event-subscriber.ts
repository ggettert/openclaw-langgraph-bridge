/**
 * Phase 2 v2 — LangGraph SSE event subscriber.
 *
 * Why this exists: LangGraph's native `webhook` field on a run is fired
 * exactly once, on terminal state. Per-step events (node started, node
 * finished, error, interrupt) only come through the SSE streaming endpoint
 * `GET /threads/{thread_id}/runs/{run_id}/stream?stream_mode=events`.
 *
 * Mode B (status absorbs silently, decision/milestone/terminal/hitl wake
 * the agent) needs per-step visibility, so we subscribe to that stream
 * for each dispatched run and translate LangGraph's native event shape
 * into our internal `{kind, flow_id, title, summary, data}` event shape,
 * then hand to the same `processEvent` the webhook handler uses.
 *
 * One subscriber per dispatched run. The dispatch tool starts it
 * fire-and-forget. The subscriber closes when LangGraph closes the stream
 * (terminal) or when an abort signal is raised.
 */

import type { IncomingEventBody } from "./webhook-handler.js";
import type { LanggraphEventKind } from "./event-classifier.js";

type LanggraphStreamEvent = {
  event?: string;
  data?: unknown;
  name?: string;
  tags?: unknown[];
  run_id?: string;
  metadata?: Record<string, unknown>;
  parent_ids?: unknown[];
};

export type ClassifiedEvent = {
  body: IncomingEventBody;
};

/**
 * Pure function: take a single LangGraph stream event and decide whether
 * to emit something into our processEvent pipeline.
 *
 * Mapping (initial heuristic — Phase 4 will tune as we see real workflows):
 *   - on_chain_start  on a NODE (not the whole graph) → milestone
 *   - on_chain_end    on a NODE → status (covers the bulk of noise)
 *   - on_tool_*       → status (deep noise)
 *   - error event     → terminal (failed)
 *   - on_chain_end    on the root graph → terminal (success)
 *   - interrupt event → hitl
 *
 * The root graph is identified by the absence of `metadata.langgraph_node`.
 * Sub-node events always carry `langgraph_node`.
 */
export function classifyStreamEvent(
  streamEvent: LanggraphStreamEvent,
  flowId: string,
  seq: number,
): IncomingEventBody | null {
  const evtType = streamEvent.event;
  const metadata = streamEvent.metadata ?? {};
  const node = metadata.langgraph_node as string | undefined;
  const step = metadata.langgraph_step as number | undefined;

  // Hard errors → terminal (failed)
  if (evtType === "error") {
    const data = streamEvent.data as { error?: string; message?: string } | undefined;
    return {
      kind: "terminal",
      flow_id: flowId,
      seq,
      title: `error: ${data?.error ?? "unknown"}`,
      summary: data?.message ?? "(no message)",
      data: { error: data?.error, message: data?.message },
    };
  }

  // Interrupt → hitl
  if (evtType === "interrupt" || evtType === "on_interrupt") {
    const data = streamEvent.data as Record<string, unknown> | undefined;
    return {
      kind: "hitl",
      flow_id: flowId,
      seq,
      title: `interrupt: ${node ?? "graph"}`,
      summary: summarizeForHumans(data),
      data,
      interrupt_id: (data?.interrupt_id as string) ?? `seq-${seq}`,
    };
  }

  // on_chain_start
  if (evtType === "on_chain_start") {
    if (!node) {
      // Whole-graph start — internal noise, skip.
      return null;
    }
    return {
      kind: "milestone",
      flow_id: flowId,
      seq,
      title: `node:${node}:start`,
      summary: `step ${step ?? "?"} \u2192 ${node}`,
      data: { node, step },
    };
  }

  // on_chain_end
  if (evtType === "on_chain_end") {
    if (!node) {
      // Root graph ended → terminal (success)
      const data = streamEvent.data as Record<string, unknown> | undefined;
      return {
        kind: "terminal",
        flow_id: flowId,
        seq,
        title: "graph:end",
        summary: "workflow completed",
        data,
      };
    }
    // Node ended — status noise
    return {
      kind: "status",
      flow_id: flowId,
      seq,
      title: `node:${node}:end`,
      summary: `step ${step ?? "?"} done`,
      data: { node, step },
    };
  }

  // Tool calls — deep noise
  if (evtType?.startsWith("on_tool_")) {
    return {
      kind: "status",
      flow_id: flowId,
      seq,
      title: `${evtType}: ${streamEvent.name ?? "tool"}`,
      summary: "",
      data: { name: streamEvent.name },
    };
  }

  // Anything else: skip. We don't want to surface every LangChain
  // model-start/model-end event yet — way too noisy.
  return null;
}

function summarizeForHumans(data: unknown): string {
  if (!data) return "";
  if (typeof data === "string") return data.slice(0, 280);
  try {
    return JSON.stringify(data).slice(0, 280);
  } catch {
    return "(unsummarizable)";
  }
}

export type SubscriberHandlers = {
  onEvent: (body: IncomingEventBody) => void;
  onError?: (err: Error) => void;
  onClose?: (reason: string) => void;
};

/**
 * Open an SSE subscription to a LangGraph run stream. Returns an
 * AbortController; call `.abort()` to stop.
 *
 * NOTE: this is fire-and-forget from the caller. Errors are not
 * propagated up — they're sent to `onError` if set, otherwise swallowed.
 */
export function subscribeToRunStream(params: {
  baseUrl: string;
  threadId: string;
  runId: string;
  flowId: string;
  handlers: SubscriberHandlers;
}): AbortController {
  const { baseUrl, threadId, runId, flowId, handlers } = params;
  const url =
    baseUrl.replace(/\/+$/, "") +
    `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/stream?stream_mode=events`;

  const controller = new AbortController();

  // Spawn the long-running task. Don't await it in the caller.
  (async () => {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        handlers.onError?.(
          new Error(
            `langgraph stream open failed: HTTP ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
          ),
        );
        return;
      }

      let seq = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffered = "";

      // Loop the SSE frames.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });

        // SSE frames are separated by blank lines.
        let frameEnd = buffered.indexOf("\n\n");
        while (frameEnd !== -1) {
          const frame = buffered.slice(0, frameEnd);
          buffered = buffered.slice(frameEnd + 2);
          handleSseFrame(frame, flowId, () => seq++, handlers);
          frameEnd = buffered.indexOf("\n\n");
        }
      }

      handlers.onClose?.("stream-ended");
    } catch (err: unknown) {
      const wasAborted = (err as { name?: string }).name === "AbortError";
      if (wasAborted) {
        handlers.onClose?.("aborted");
        return;
      }
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return controller;
}

function handleSseFrame(
  frame: string,
  flowId: string,
  nextSeq: () => number,
  handlers: SubscriberHandlers,
): void {
  // Frame is one or more `field: value` lines. We only care about `event:`
  // and `data:`. Data may span multiple lines.
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return;

  let data: unknown;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    // Best-effort: not JSON, drop it. Could log if we had a logger here.
    return;
  }

  const streamEvent: LanggraphStreamEvent = {
    event: eventName,
    ...(typeof data === "object" && data !== null ? (data as object) : { data }),
  };

  const body = classifyStreamEvent(streamEvent, flowId, nextSeq());
  if (body) handlers.onEvent(body);
}
