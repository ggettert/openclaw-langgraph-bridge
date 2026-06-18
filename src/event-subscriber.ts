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
import { isPhaseEventPayload } from "./phase-event.js";

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

    // Special case: LangGraph signals a HITL interrupt by emitting an
    // updates frame with the synthetic node name "__interrupt__". The
    // delta is typically an array of Interrupt objects: [{value, id, ...}].
    // Map this to Mode B hitl so the flow goes to waiting state and the
    // agent is woken to ask the human.
    if (node === "__interrupt__") {
      const interrupts = Array.isArray(delta) ? delta : [delta];
      const first = (interrupts[0] ?? {}) as Record<string, unknown>;
      const prompt = summarizeInterruptPrompt(first);
      return {
        kind: "emit",
        body: {
          kind: "hitl",
          flow_id: flowId,
          seq,
          title: "interrupt",
          summary: prompt,
          data: { interrupts },
          interrupt_id:
            (first.id as string | undefined) ??
            (first.interrupt_id as string | undefined) ??
            `seq-${seq}`,
        },
      };
    }

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
  // Three recognized shapes (in priority order):
  //   1. Explicit Mode B: {kind: "status|milestone|decision|terminal|hitl",
  //      title?, summary?, interrupt_id?} — pass through.
  //   2. Native fleet vocabulary: {phase: "<name>", event: "started|finished|failed", ...}
  //      — translate to Mode B using event-name heuristic.
  //   3. Other custom payload — degrade to status.
  if (frame.event === "custom") {
    const data = frame.data as Record<string, unknown> | undefined;
    if (data && typeof data === "object") {
      // Shape 1: explicit Mode B
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

      // Shape 2a: typed PhaseEventPayload — fast path when isPhaseEventPayload
      // validates true (schema_version present or required fields all valid).
      // Trust the typed fields; translateFleetVocabulary still maps kind/title,
      // but we KNOW summary is present so it's used verbatim with no heuristic.
      if (isPhaseEventPayload(data)) {
        const translated = translateFleetVocabulary(data.phase, data.event, data);
        return {
          kind: "emit",
          body: {
            ...translated,
            flow_id: flowId,
            seq,
            data,
          },
        };
      }

      // Shape 2b: legacy fleet vocabulary {phase, event, ...} without required
      // fields (e.g. no summary, no ticket_id). Falls back to heuristic summary.
      const phase = data.phase as string | undefined;
      const fleetEvent = data.event as string | undefined;
      if (phase && fleetEvent) {
        const translated = translateFleetVocabulary(phase, fleetEvent, data);
        return {
          kind: "emit",
          body: {
            ...translated,
            flow_id: flowId,
            seq,
            data,
          },
        };
      }
    }

    // Shape 3: unknown custom payload
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

// ---------------------------------------------------------------------------
// Summary truncation helpers
// ---------------------------------------------------------------------------

// Truncation utilities moved to ./text-utils.js and re-exported for
// backward compatibility with existing import sites and tests.
export {
  DEFAULT_SUMMARY_MAX_CHARS,
  truncateSummary,
  truncateJsonSummary,
} from "./text-utils.js";
import { truncateSummary, truncateJsonSummary } from "./text-utils.js";

const VALID_KINDS = new Set<string>([
  "status",
  "milestone",
  "decision",
  "terminal",
  "hitl",
]);

/**
 * Translate native fleet `{phase, event, ...}` custom events into Mode B
 * shape. Used when a workflow author uses the project's own _emit()
 * helper rather than writing the explicit Mode B `kind` field.
 *
 * Event-name heuristic:
 *   - started / start              → milestone, title="<phase>:started"
 *   - finished / complete / done   → milestone, title="<phase>:finished"
 *   - failed / error               → terminal (failed)
 *   - progress / update            → status
 *   - anything else                → status
 */
function translateFleetVocabulary(
  phase: string,
  fleetEvent: string,
  data: Record<string, unknown>,
): {
  kind: LanggraphEventKind;
  title: string;
  summary: string;
} {
  const eventNorm = fleetEvent.toLowerCase();

  // Explicit summary preferred over summarizeFleetData heuristic.
  // Truncation is owned by processEvent (see summaryMaxChars).
  const explicitSummary =
    typeof data.summary === "string" && data.summary.length > 0
      ? data.summary
      : null;
  const summary = explicitSummary ?? summarizeFleetData(data);

  if (eventNorm === "started" || eventNorm === "start") {
    return { kind: "milestone", title: `${phase}:started`, summary };
  }
  if (
    eventNorm === "finished" ||
    eventNorm === "complete" ||
    eventNorm === "completed" ||
    eventNorm === "done"
  ) {
    return { kind: "milestone", title: `${phase}:finished`, summary };
  }
  if (eventNorm === "failed" || eventNorm === "error") {
    return { kind: "terminal", title: `${phase}:${fleetEvent}`, summary };
  }
  return { kind: "status", title: `${phase}:${fleetEvent}`, summary };
}

/**
 * Build a one-line summary from native fleet event payload. Prefers the
 * fields most likely to be useful in a Slack message (pr_url, ticket_id,
 * verdict, etc.) over raw JSON.
 */
function summarizeFleetData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  const tid = data.ticket_id;
  if (typeof tid === "string") parts.push(tid);
  const pr = data.pr_url;
  if (typeof pr === "string") parts.push(pr);
  const branch = data.branch;
  if (typeof branch === "string" && !parts.includes(branch)) parts.push(branch);
  const verdict = data.verdict;
  if (typeof verdict === "string") parts.push(`verdict=${verdict}`);
  const techSpec = data.tech_spec_path;
  if (typeof techSpec === "string") parts.push(techSpec);
  const productSpec = data.product_spec_path;
  if (typeof productSpec === "string" && !parts.includes(productSpec))
    parts.push(productSpec);
  const rev = data.revision_count;
  if (typeof rev === "number") parts.push(`rev=${rev}`);
  if (parts.length > 0) return truncateSummary(parts.join(" | "));
  return summarizeForHumans(data);
}

function isValidKind(s: string): s is LanggraphEventKind {
  return VALID_KINDS.has(s);
}

/**
 * Best-effort human prompt extraction from a LangGraph Interrupt object.
 * The `value` field is whatever the workflow passed to `interrupt(...)`
 * — commonly a dict like {"prompt": "..."} or a plain string.
 */
function summarizeInterruptPrompt(interrupt: Record<string, unknown>): string {
  const value = interrupt.value;
  if (typeof value === "string") return truncateSummary(value);
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const prompt =
      (v.prompt as string | undefined) ??
      (v.message as string | undefined) ??
      (v.question as string | undefined);
    if (prompt) return truncateSummary(prompt);
  }
  return summarizeForHumans(value);
}

function summarizeForHumans(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return truncateSummary(data);
  return truncateJsonSummary(data);
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
  /**
   * Either `input` (initial run) OR `command` (resume from interrupt).
   * LangGraph's RunCreateStateful schema accepts both, but only one is
   * meaningful per request. When `command` is provided, `input` is
   * ignored.
   */
  input?: Record<string, unknown> | null;
  command?: { resume?: unknown; [k: string]: unknown } | null;
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
    command,
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
        // Resume runs send `command` (e.g. {resume: ...}); initial runs
        // send `input`. Sending both is undefined behaviour per the
        // RunCreateStateful schema, so only the relevant key is included.
        body: JSON.stringify(
          command
            ? {
                assistant_id: assistantId,
                command,
                metadata: metadata ?? undefined,
                stream_mode: ["updates", "custom"],
              }
            : {
                assistant_id: assistantId,
                input: input ?? null,
                metadata: metadata ?? undefined,
                stream_mode: ["updates", "custom"],
              },
        ),
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
            // `sawTerminal` controls whether the synthetic stream-close
            // terminal fires. Both `terminal` and `hitl` events are real
            // endpoints — the workflow has either completed or paused at
            // an interrupt. Suppress the synthetic terminal in both cases
            // so we don't overwrite the hitl waiting state with a
            // graph:end terminal.
            if (result.body.kind === "terminal" || result.body.kind === "hitl") {
              sawTerminal = true;
            }
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
