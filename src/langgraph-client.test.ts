import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LanggraphClient,
  LanggraphHttpError,
  type LanggraphAssistant,
} from "./langgraph-client.js";

describe("LanggraphClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  function mockFetch(impl: typeof fetch) {
    globalThis.fetch = impl as typeof fetch;
  }

  it("strips trailing slashes from baseUrl", async () => {
    let receivedUrl: string | undefined;
    mockFetch(async (input) => {
      receivedUrl = typeof input === "string" ? input : (input as Request).url;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new LanggraphClient({ baseUrl: "http://x.example:2024///" });
    await client.ok();
    expect(receivedUrl).toBe("http://x.example:2024/ok");
  });

  it("createThread returns thread_id from response body", async () => {
    mockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      expect(url).toBe("http://lg/threads");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ thread_id: "t-123" }), { status: 200 });
    });
    const client = new LanggraphClient({ baseUrl: "http://lg" });
    const id = await client.createThread({ tag: "x" });
    expect(id).toBe("t-123");
  });

  it("createRun sends assistant_id + metadata and returns run_id", async () => {
    const captured: { url?: string; body?: unknown } = {};
    mockFetch(async (input, init) => {
      captured.url = typeof input === "string" ? input : (input as Request).url;
      captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(JSON.stringify({ run_id: "r-9", thread_id: "t-7" }), { status: 200 });
    });
    const client = new LanggraphClient({ baseUrl: "http://lg" });
    const result = await client.createRun("t-7", {
      assistantId: "fleet",
      input: { hello: "world" },
      metadata: { openclaw_flow_id: "f-1" },
    });
    expect(captured.url).toBe("http://lg/threads/t-7/runs");
    expect(captured.body).toEqual({
      assistant_id: "fleet",
      input: { hello: "world" },
      metadata: { openclaw_flow_id: "f-1" },
    });
    expect(result).toEqual({
      threadId: "t-7",
      runId: "r-9",
      raw: { run_id: "r-9", thread_id: "t-7" },
    });
  });

  it("throws LanggraphHttpError on non-2xx", async () => {
    mockFetch(async () => new Response("nope", { status: 500, statusText: "Internal" }));
    const client = new LanggraphClient({ baseUrl: "http://lg" });
    await expect(client.createThread()).rejects.toBeInstanceOf(LanggraphHttpError);
  });

  it("createRun throws when run_id missing", async () => {
    mockFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    const client = new LanggraphClient({ baseUrl: "http://lg" });
    await expect(client.createRun("t-1", { assistantId: "fleet" })).rejects.toBeInstanceOf(
      LanggraphHttpError,
    );
  });

  describe("getAssistantSchemas", () => {
    it("returns schemas on success", async () => {
      const schemas = {
        input_schema: {
          title: "FleetState",
          type: "object",
          properties: {
            ticket_id: { type: "string" },
            repo: { type: "string" },
            spec_path: { type: "string" },
          },
          required: ["ticket_id", "repo", "spec_path"],
        },
        output_schema: { title: "FleetState", type: "object" },
        state_schema: { title: "FleetState", type: "object" },
        config_schema: { title: "Configurable", type: "object" },
      };
      let receivedUrl: string | undefined;
      mockFetch(async (input, init) => {
        receivedUrl = typeof input === "string" ? input : (input as Request).url;
        expect(init?.method).toBe("GET");
        return new Response(JSON.stringify(schemas), { status: 200 });
      });
      const client = new LanggraphClient({ baseUrl: "http://lg" });
      const result = await client.getAssistantSchemas("fleet");
      expect(receivedUrl).toBe("http://lg/assistants/fleet/schemas");
      expect(result).toEqual(schemas);
    });

    it("URL-encodes the workflow id", async () => {
      let receivedUrl: string | undefined;
      mockFetch(async (input) => {
        receivedUrl = typeof input === "string" ? input : (input as Request).url;
        return new Response(JSON.stringify({}), { status: 200 });
      });
      const client = new LanggraphClient({ baseUrl: "http://lg" });
      await client.getAssistantSchemas("6d5d4365-62fd-59e2-807b-539d8f85d26e");
      expect(receivedUrl).toBe("http://lg/assistants/6d5d4365-62fd-59e2-807b-539d8f85d26e/schemas");
    });

    it("throws LanggraphHttpError with status 404 when workflow not found", async () => {
      mockFetch(
        async () =>
          new Response(JSON.stringify({ detail: "Assistant not found" }), {
            status: 404,
            statusText: "Not Found",
          }),
      );
      const client = new LanggraphClient({ baseUrl: "http://lg" });
      const err = await client.getAssistantSchemas("no-such-workflow").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LanggraphHttpError);
      expect((err as LanggraphHttpError).status).toBe(404);
    });

    it("propagates network errors as plain Error", async () => {
      mockFetch(async () => {
        throw new TypeError("fetch failed");
      });
      const client = new LanggraphClient({ baseUrl: "http://lg" });
      await expect(client.getAssistantSchemas("fleet")).rejects.toThrow("fetch failed");
    });

    it("aborts and rejects on timeout", async () => {
      mockFetch(async (_input, init) => {
        // Wait until the AbortSignal fires, then throw
        await new Promise<void>((_, reject) => {
          const signal = (init as RequestInit).signal;
          if (signal) {
            signal.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }
        });
        return new Response(null, { status: 200 });
      });
      const client = new LanggraphClient({ baseUrl: "http://lg", timeoutMs: 50 });
      const promise = client.getAssistantSchemas("fleet");
      vi.advanceTimersByTime(51);
      await expect(promise).rejects.toThrow();
    });
  });

  describe("searchAssistants", () => {
    const mockAssistants: LanggraphAssistant[] = [
      {
        assistant_id: "6d5d4365-62fd-59e2-807b-539d8f85d26e",
        graph_id: "fleet",
        name: "Fleet Workflow",
        description: "Runs the fleet orchestration pipeline",
        metadata: {},
        config: {},
      },
      {
        assistant_id: "aabbccdd-0000-1111-2222-333344445555",
        graph_id: "triage",
        name: "Triage Agent",
        description: null,
        metadata: {},
      },
    ];

    it("returns parsed array of assistants", async () => {
      mockFetch(async () => new Response(JSON.stringify(mockAssistants), { status: 200 }));
      const client = new LanggraphClient({ baseUrl: "http://lg" });
      const result = await client.searchAssistants();
      expect(result).toEqual(mockAssistants);
      expect(result).toHaveLength(2);
      expect(result[0].assistant_id).toBe("6d5d4365-62fd-59e2-807b-539d8f85d26e");
      expect(result[1].description).toBeNull();
    });

    it("sends POST to /assistants/search with correct body including limit", async () => {
      const captured: { url?: string; method?: string; body?: unknown } = {};
      mockFetch(async (input, init) => {
        captured.url = typeof input === "string" ? input : (input as Request).url;
        captured.method = init?.method;
        captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify([]), { status: 200 });
      });
      const client = new LanggraphClient({ baseUrl: "http://lg" });
      await client.searchAssistants(42);
      expect(captured.url).toBe("http://lg/assistants/search");
      expect(captured.method).toBe("POST");
      expect(captured.body).toEqual({ limit: 42 });
    });

    it("uses default limit of 100 when not specified", async () => {
      let capturedBody: unknown;
      mockFetch(async (_input, init) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(JSON.stringify([]), { status: 200 });
      });
      const client = new LanggraphClient({ baseUrl: "http://lg" });
      await client.searchAssistants();
      expect(capturedBody).toEqual({ limit: 100 });
    });

    it("throws LanggraphHttpError on 5xx", async () => {
      mockFetch(
        async () =>
          new Response("Internal Server Error", {
            status: 500,
            statusText: "Internal Server Error",
          }),
      );
      const client = new LanggraphClient({ baseUrl: "http://lg" });
      const err = await client.searchAssistants().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LanggraphHttpError);
      expect((err as LanggraphHttpError).status).toBe(500);
    });

    it("aborts and rejects on timeout", async () => {
      mockFetch(async (_input, init) => {
        await new Promise<void>((_, reject) => {
          const signal = (init as RequestInit).signal;
          if (signal) {
            signal.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }
        });
        return new Response(null, { status: 200 });
      });
      const client = new LanggraphClient({ baseUrl: "http://lg", timeoutMs: 50 });
      const promise = client.searchAssistants();
      vi.advanceTimersByTime(51);
      await expect(promise).rejects.toThrow();
    });
  });
});
