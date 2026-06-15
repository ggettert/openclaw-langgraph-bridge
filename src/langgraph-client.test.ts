import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanggraphClient, LanggraphHttpError } from "./langgraph-client.js";

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
    let captured: { url?: string; body?: unknown } = {};
    mockFetch(async (input, init) => {
      captured.url = typeof input === "string" ? input : (input as Request).url;
      captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(
        JSON.stringify({ run_id: "r-9", thread_id: "t-7" }),
        { status: 200 },
      );
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
    expect(result).toEqual({ threadId: "t-7", runId: "r-9", raw: { run_id: "r-9", thread_id: "t-7" } });
  });

  it("throws LanggraphHttpError on non-2xx", async () => {
    mockFetch(async () => new Response("nope", { status: 500, statusText: "Internal" }));
    const client = new LanggraphClient({ baseUrl: "http://lg" });
    await expect(client.createThread()).rejects.toBeInstanceOf(LanggraphHttpError);
  });

  it("createRun throws when run_id missing", async () => {
    mockFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
    const client = new LanggraphClient({ baseUrl: "http://lg" });
    await expect(
      client.createRun("t-1", { assistantId: "fleet" }),
    ).rejects.toBeInstanceOf(LanggraphHttpError);
  });
});
