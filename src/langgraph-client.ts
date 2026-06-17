/**
 * Minimal LangGraph Server HTTP client.
 *
 * The dev server we target exposes (verified against 0.10.0 at langgraph.example.local:2024):
 *   GET  /ok                          → liveness
 *   GET  /info                        → server metadata
 *   GET  /assistants/{id}/schemas     → input/output/state/config schemas
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

/**
 * A single assistant record returned by POST /assistants/search.
 *
 * Verified shape (LangGraph Server 0.10.0, langgraph.example.local:2024):
 *
 *   {
 *     "assistant_id": "<uuid>",
 *     "graph_id": "fleet",
 *     "name": "Fleet Workflow",
 *     "description": "...",
 *     "metadata": {},
 *     "config": {}
 *   }
 *
 * `description` may be null if the workflow author did not set one.
 */
export type LanggraphAssistant = {
  assistant_id: string;
  graph_id: string;
  name: string;
  description: string | null;
  metadata?: Record<string, unknown>;
  config?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Schema bundle returned by GET /assistants/{assistant_id}/schemas.
 *
 * All four fields are optional — LangGraph omits them when the workflow
 * does not declare them explicitly. Typical shape (verified on the fleet
 * POC workflow at langgraph.example.local:2024):
 *
 *   {
 *     "input_schema":  { "title": "...", "type": "object", "properties": { ... } },
 *     "output_schema": { "title": "...", "type": "object", ... },
 *     "state_schema":  { "title": "...", "type": "object", "properties": { ... } },
 *     "config_schema": { "title": "...", "type": "object", ... }
 *   }
 *
 * Use input_schema to validate the shape you pass to langgraph_dispatch.
 * LangGraph silently drops unknown keys at graph entry — mismatched keys
 * cause downstream node KeyErrors rather than a clean error at dispatch.
 */
export type AssistantSchemas = {
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  state_schema?: Record<string, unknown>;
  config_schema?: Record<string, unknown>;
  [key: string]: unknown;
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

  /**
   * Fetch the schema bundle for a workflow / assistant.
   *
   * GET /assistants/{assistant_id}/schemas
   *
   * Returns the JSON-Schema definitions the LangGraph server publishes for
   * the workflow's input, output, state, and config surfaces. Call this
   * BEFORE dispatching any workflow whose input shape you don't already
   * know — LangGraph silently drops unknown keys at graph entry, causing
   * downstream nodes to KeyError mid-run.
   *
   * @throws {LanggraphHttpError} with status 404 when the workflow is unknown.
   * @throws {LanggraphHttpError} with status 5xx on server errors.
   * @throws {Error} on network failure or timeout.
   */
  async getAssistantSchemas(workflowId: string): Promise<AssistantSchemas> {
    const path = `/assistants/${encodeURIComponent(workflowId)}/schemas`;
    const res = await this.fetch(path, { method: "GET" });
    return (await res.json()) as AssistantSchemas;
  }

  /**
   * Search / list assistants registered on the LangGraph server.
   *
   * POST /assistants/search { "limit": <n> }
   *
   * Returns an array of assistant objects. Each item has at minimum:
   *   - assistant_id {string}       — stable UUID for the assistant
   *   - graph_id    {string}        — graph/workflow identifier (e.g. "fleet")
   *   - name        {string}        — human-readable name
   *   - description {string|null}   — optional description (null when not set)
   *
   * @param limit  Max results to return (default 100). LangGraph will cap this
   *               at its own server-side limit if you ask for more.
   * @throws {LanggraphHttpError} on 4xx/5xx server errors.
   * @throws {Error} on network failure or timeout.
   */
  async searchAssistants(limit = 100): Promise<LanggraphAssistant[]> {
    const res = await this.fetch("/assistants/search", {
      method: "POST",
      body: { limit },
    });
    return (await res.json()) as LanggraphAssistant[];
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

  /**
   * Resume an interrupted run by creating a new run on the same thread
   * with a `Command(resume=...)` input. LangGraph reads the resume
   * payload, advances the interrupted node, and continues.
   *
   * The wire shape for `Command(resume=...)` over HTTP is
   * `{"command": {"resume": <payload>}}` as the run input.
   */
  async resumeRun(
    threadId: string,
    assistantId: string,
    resumePayload: unknown,
    opts?: { metadata?: Record<string, unknown> },
  ): Promise<LanggraphCreateRunResult> {
    return this.createRun(threadId, {
      assistantId,
      input: { command: { resume: resumePayload } } as unknown as Record<
        string,
        unknown
      >,
      metadata: opts?.metadata,
    });
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
