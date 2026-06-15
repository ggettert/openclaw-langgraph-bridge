/**
 * Minimal LangGraph Server HTTP client.
 *
 * The dev server we target exposes (verified against 0.10.0 at 10.41.1.198:2024):
 *   GET  /ok                          → liveness
 *   GET  /info                        → server metadata
 *   POST /assistants/search           → list assistants
 *   POST /threads                     → create a thread
 *   POST /threads/{thread_id}/runs    → start a run on a thread
 *   POST /threads/{thread_id}/runs/{run_id}/cancel  (Phase 4)
 *
 * This module is intentionally thin: no streaming, no retries beyond a single
 * configurable timeout. Production hardening (retry/backoff, error-shape
 * normalization, idempotency keys) lands in Phase 4.
 */

export type LanggraphClientOptions = {
  baseUrl: string;
  /** Per-request timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
};

export type LanggraphCreateRunOptions = {
  assistantId: string;
  input?: Record<string, unknown> | null;
  /** Stored on the run; LangGraph round-trips this verbatim to webhook callers. */
  metadata?: Record<string, unknown>;
  /** Optional webhook URL LangGraph will POST run events to (terminal-only on LangGraph). */
  webhook?: string;
  /**
   * Stream modes to persist on the run. We pass ["events"] so the SSE
   * subscriber can join + replay even if it connects after a fast run
   * already completed.
   */
  streamMode?: string[];
  /**
   * Whether to persist stream chunks for late subscribers. Phase 2 v2
   * needs this true so the subscriber can read the full event history
   * even if it loses the race with a very fast workflow.
   */
  streamResumable?: boolean;
};

export type LanggraphCreateRunResult = {
  threadId: string;
  runId: string;
  raw: unknown;
};

export class LanggraphHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "LanggraphHttpError";
  }
}

export class LanggraphClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: LanggraphClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async ok(): Promise<boolean> {
    try {
      const res = await this.fetch("/ok", { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }

  async info(): Promise<Record<string, unknown>> {
    const res = await this.fetch("/info", { method: "GET" });
    return (await res.json()) as Record<string, unknown>;
  }

  async createThread(metadata?: Record<string, unknown>): Promise<string> {
    const res = await this.fetch("/threads", {
      method: "POST",
      body: { metadata: metadata ?? {} },
    });
    const body = (await res.json()) as { thread_id?: string };
    if (!body.thread_id) {
      throw new LanggraphHttpError(
        "LangGraph create-thread did not return thread_id",
        res.status,
        JSON.stringify(body),
      );
    }
    return body.thread_id;
  }

  async createRun(threadId: string, opts: LanggraphCreateRunOptions): Promise<LanggraphCreateRunResult> {
    const body: Record<string, unknown> = {
      assistant_id: opts.assistantId,
      input: opts.input ?? null,
    };
    if (opts.metadata) {
      body.metadata = opts.metadata;
    }
    if (opts.webhook) {
      body.webhook = opts.webhook;
    }
    if (opts.streamMode && opts.streamMode.length > 0) {
      body.stream_mode = opts.streamMode;
    }
    if (opts.streamResumable !== undefined) {
      body.stream_resumable = opts.streamResumable;
    }
    const res = await this.fetch(`/threads/${encodeURIComponent(threadId)}/runs`, {
      method: "POST",
      body,
    });
    const parsed = (await res.json()) as { run_id?: string; thread_id?: string };
    if (!parsed.run_id) {
      throw new LanggraphHttpError(
        "LangGraph create-run did not return run_id",
        res.status,
        JSON.stringify(parsed),
      );
    }
    return {
      threadId: parsed.thread_id ?? threadId,
      runId: parsed.run_id,
      raw: parsed,
    };
  }

  private async fetch(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method: init.method,
        headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new LanggraphHttpError(
          `LangGraph ${init.method} ${path} failed: ${res.status} ${res.statusText}`,
          res.status,
          text,
        );
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}
