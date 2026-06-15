/**
 * Phase 2 v3 — LangGraph streaming SSE consumer (rewritten against the
 * documented v2 stream-mode API).
 *
 * Architecture (read this before the code):
 *
 * 1. We use `POST /threads/{tid}/runs/stream` rather than separate
 *    `createRun` + `GET /runs/{rid}/stream`. The streaming-create
 *    endpoint atomically starts the run AND opens the SSE stream as
 *    its response body, so there's no race window where a fast run
 *    can complete before we connect.
 *
 * 2. We request `stream_mode=["updates","custom"]`. Per the LangChain
 *    docs:
 *      - `updates` yields a `StreamPart` of type `"updates"` whose
 *        `data` is `{<node_name>: <node_state_delta>}` after each
 *        step. This is our milestone signal.
 *      - `custom` yields a `StreamPart` of type `"custom"` whose
 *        `data` is whatever the workflow author wrote via
 *        `get_stream_writer()`. This is the Mode B escape hatch: if
 *        the workflow wants to emit a `{kind: "decision", ...}` event,
 *        it writes a JSON object with our shape.
 *
 * 3. SSE frames from the LangGraph server use the standard wire
 *    format: `event: <name>` + `data: <json>` separated by blank lines.
 *    The first frame is always `event: metadata` with the `run_id`.
 *    Subsequent frames carry one of: `updates`, `custom`, `messages`,
 *    `values`, `error`, `events` (the v1 internal-event firehose; we
 *    do not subscribe to it but still tolerate it gracefully).
 *
 * 4. The classifier (`classifyStreamFrame`) maps each frame to our
 *    internal Mode B `{kind, flow_id, ...}` event body. Mapping:
 *      - `metadata`             → null (used out-of-band for run_id)
 *      - `updates` (sub-node)   → milestone
 *      - `error`                → terminal (failed)
 *      - `custom` (kind=...)    → pass through with author's kind
 *      - `custom` (other)       → status
 *      - everything else        → null (skip)
 *
 *    Stream-end (no terminal-kind event seen) is treated as a synthetic
 *    `terminal` (success) by the caller, not by this function.
 */

import type { IncomingEventBody } from "./webhook-handler.js";
import type { LanggraphEventKind } from "./event-classifier.js";

/** One parsed SSE frame from the LangGraph stream. */
export type ParsedStreamFrame = {
  event: string;
  data: unknown;
};

/** Result of classifying a single frame. */
export type ClassifyResult =
  | { kind: "skip" }
  | { kind: "metadata"; runId: string }
  | { kind: "emit"; body: IncomingEventBody };

/**
 * Pure function: classify one SSE frame. Returns either `skip` (no-op),
 * `metadata` (parse run_id; emit nothing), or `emit` with the Mode B
 * body to hand to processEvent.
 */
export function classifyStreamFrame(
  frame: ParsedStreamFrame,
  flowId: string,
  seq: number,
): ClassifyResult {
  // Metadata frame: first frame on every stream. We use it to capture
  // run_id but do not surface an event to the agent.
  if (frame.event === "metadata") {
    const data = frame.data as { run_id?: string } | undefined;
    if (data?.run_id) {
      return { kind: "metadata", runId: data.run_id };
    }
    return { kind: "skip" };
  }

  // Error frame: terminal-failed.
  if (frame.event === "error") {
    const data = frame.data as { error?: string; message?: string } | undefined;
    return {
      kind: "emit",
      body: {
        kind: "terminal",
        flow_id: flowId,
        seq,
        title: `error: ${data?.error ?? "unknown"}`,
        summary: data?.message ?? "(no message)",
        data: { error: data?.error, message: data?.message },
      },
    };
  }

  // Updates frame: {type: "updates", ns: [...], data: {<node>: <delta>}}.
  // Per docs, top-level wire shape from the HTTP API is the raw {type,
  // ns, data} object — but the dev server we hit is actually emitting
  // it as `event: updates` with a JSON body of {<node>: <delta>}.
  // Tolerate both shapes (test both, see test file).
  if (frame.event === "updates") {
    const data = frame.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object") return { kind: "skip" };

    // If the body looks like a v2 StreamPart wrapper, unwrap.
    const payload =
      "type" in data && (data as { type?: string }).type === "updates"
        ? ((data as { data?: Record<string, unknown> }).data ?? {})
        : data;

    // Each key is a node name; we surface one milestone per key.
    const nodeNames = Object.keys(payload);
    if (nodeNames.length === 0) return { kind: "skip" };

    // Take the first node name; for multi-node updates we'd
    // emit several, but Phase 2 emits one summary event.
    const node = nodeNames[0]!;
    const delta = (payload as Record<string, unknown>)[node];
    return {
      kind: "emit",
      body: {
        kind: "milestone",
        flow_id: flowId,
        seq,
        title: `node:${node}`,
        summary: summarizeForHumans(delta),
        data: { node, delta },
      },
    };
  }

  // Custom frame: the workflow author wrote via get_stream_writer().
  // If the data carries a recognizable `kind`, pass it through as Mode
  // B. Otherwise treat as status.
  if (frame.event === "custom") {
    const data = frame.data as Record<string, unknown> | undefined;
    if (data && typeof data === "object") {
      const authorKind = data.kind as string | undefined;
      if (authorKind && isValidKind(authorKind)) {
        return {
          kind: "emit",
          body: {
            kind: authorKind,
            flow_id: flowId,
            seq,
            title: (data.title as string) ?? `custom:${authorKind}`,
            summary: (data.summary as string) ?? summarizeForHumans(data),
            data: data,
            interrupt_id: data.interrupt_id as string | undefined,
          },
        };
      }
    }
    return {
      kind: "emit",
      body: {
        kind: "status",
        flow_id: flowId,
        seq,
        title: "custom",
        summary: summarizeForHumans(data),
        data: data as Record<string, unknown> | undefined,
      },
    };
  }

  // Everything else (messages, values, events, checkpoints, tasks,
  // debug, end) → skip silently. The agent doesn't need token-level
  // streams in Mode B.
  return { kind: "skip" };
}

const VALID_KINDS = new Set<string>([
  "status",
  "milestone",
  "decision",
  "terminal",
  "hitl",
]);

function isValidKind(s: string): s is LanggraphEventKind {
  return VALID_KINDS.has(s);
}

function summarizeForHumans(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data.slice(0, 280);
  try {
    return JSON.stringify(data).slice(0, 280);
  } catch {
    return "(unsummarizable)";
  }
}

// ---------------------------------------------------------------------------
// SSE reader
// ---------------------------------------------------------------------------

export type StreamHandlers = {
  /** Emitted exactly once when the metadata frame parses. */
  onRunId?: (runId: string) => void;
  /** Emitted for each frame that classifies to `emit`. */
  onEvent: (body: IncomingEventBody) => void;
  /** Emitted when the stream errors out at the transport layer. */
  onError?: (err: Error) => void;
  /**
   * Emitted exactly once when the stream closes naturally. The boolean
   * indicates whether we saw any terminal-kind event during the stream.
   */
  onClose?: (sawTerminal: boolean) => void;
};

export type StreamingDispatchParams = {
  baseUrl: string;
  threadId: string;
  flowId: string;
  assistantId: string;
  input?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  handlers: StreamHandlers;
  fetchImpl?: typeof fetch;
};

/**
 * Atomic create+stream: opens the SSE response from
 * `POST /threads/{tid}/runs/stream` and pumps frames through the
 * classifier into the handlers. Returns an `AbortController` for
 * cancellation. Returns immediately; the streaming happens in the
 * background.
 */
export function dispatchAndStream(
  params: StreamingDispatchParams,
): AbortController {
  const {
    baseUrl,
    threadId,
    flowId,
    assistantId,
    input,
    metadata,
    handlers,
    fetchImpl,
  } = params;

  const controller = new AbortController();
  const url =
    baseUrl.replace(/\/+$/, "") +
    `/threads/${encodeURIComponent(threadId)}/runs/stream`;

  (async () => {
    let sawTerminal = false;
    const f = fetchImpl ?? fetch;
    try {
      const res = await f(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          assistant_id: assistantId,
          input: input ?? null,
          metadata: metadata ?? undefined,
          stream_mode: ["updates", "custom"],
        }),
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

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffered = "";
      let seq = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });

        // SSE frames may be separated by "\n\n" or "\r\n\r\n" depending
        // on the server. The LangGraph dev server emits CRLF. Handle both.
        for (;;) {
          const crlfIdx = buffered.indexOf("\r\n\r\n");
          const lfIdx = buffered.indexOf("\n\n");
          let frameEnd = -1;
          let sepLen = 0;
          if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) {
            frameEnd = crlfIdx;
            sepLen = 4;
          } else if (lfIdx !== -1) {
            frameEnd = lfIdx;
            sepLen = 2;
          }
          if (frameEnd === -1) break;
          const raw = buffered.slice(0, frameEnd);
          buffered = buffered.slice(frameEnd + sepLen);
          const frame = parseSseFrame(raw);
          if (!frame) continue;
          const result = classifyStreamFrame(frame, flowId, seq++);
          if (result.kind === "metadata") {
            handlers.onRunId?.(result.runId);
          } else if (result.kind === "emit") {
            if (result.body.kind === "terminal") sawTerminal = true;
            handlers.onEvent(result.body);
          }
        }
      }

      handlers.onClose?.(sawTerminal);
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "AbortError") {
        handlers.onClose?.(sawTerminal);
        return;
      }
      handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return controller;
}

/** Parse a single SSE frame ("event: foo\ndata: ..."). Pure. */
export function parseSseFrame(raw: string): ParsedStreamFrame | null {
  let eventName = "message";
  const dataLines: string[] = [];
  // SSE lines may end with \n or \r\n. Strip \r before checking prefixes.
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  try {
    const data: unknown = JSON.parse(dataLines.join("\n"));
    return { event: eventName, data };
  } catch {
    return null;
  }
}
