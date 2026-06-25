/**
 * Tests for F3 — timing-safe token comparison.
 *
 * Covers `safeCompare` unit behaviour and an integration path through
 * `buildHandler` to verify that a wrong-length token still 401s.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { buildHandler, safeCompare } from "./webhook-handler.js";
import { makeFakeDeps } from "./test-harness.js";

// ---------------------------------------------------------------------------
// safeCompare unit tests
// ---------------------------------------------------------------------------

describe("safeCompare", () => {
  it("returns true for identical strings", () => {
    expect(safeCompare("correct-horse-battery-staple", "correct-horse-battery-staple")).toBe(true);
  });

  it("returns false for same-length strings with different content", () => {
    expect(safeCompare("aaaa", "bbbb")).toBe(false);
  });

  it("returns false when presented is shorter than expected", () => {
    expect(safeCompare("short", "longer-token")).toBe(false);
  });

  it("returns false when presented is longer than expected", () => {
    expect(safeCompare("longer-token", "short")).toBe(false);
  });

  it("returns false for empty presented against non-empty expected", () => {
    expect(safeCompare("", "secret")).toBe(false);
  });

  it("returns false for non-empty presented against empty expected", () => {
    expect(safeCompare("secret", "")).toBe(false);
  });

  it("returns true for empty-vs-empty (both zero length)", () => {
    // Edge case: both sides zero-length buffers are equal.
    expect(safeCompare("", "")).toBe(true);
  });

  it("handles multi-byte UTF-8 correctly (same string → true)", () => {
    const token = "tök€n-with-unicode";
    expect(safeCompare(token, token)).toBe(true);
  });

  it("handles multi-byte UTF-8 correctly (different string → false)", () => {
    expect(safeCompare("tök€n-A", "tök€n-B")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: buildHandler uses safeCompare — wrong-length token still 401s
// ---------------------------------------------------------------------------

/** Minimal mock IncomingMessage */
function makeReq(options?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const method = options?.method ?? "POST";
  const headers = options?.headers ?? { authorization: "Bearer secret" };
  const bodyStr = options?.body ?? JSON.stringify({ kind: "status", flow_id: "f1", title: "test" });

  const emitter = new EventEmitter() as IncomingMessage;
  emitter.method = method;
  emitter.headers = headers;
  setImmediate(() => {
    emitter.emit("data", Buffer.from(bodyStr, "utf8"));
    emitter.emit("end");
  });
  return emitter;
}

/** Minimal mock ServerResponse */
function makeRes(): ServerResponse & { _statusCode: number; _body: string } {
  const res = {
    _statusCode: 0,
    _body: "",
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn((body: string) => {
      res._statusCode = res.statusCode;
      res._body = body;
    }),
  } as unknown as ServerResponse & { _statusCode: number; _body: string };
  return res;
}

describe("buildHandler — safeCompare integration", () => {
  it("401s when presented token is correct-length but wrong content", async () => {
    const { deps } = makeFakeDeps({ expectedToken: "secret-token-16ch" });
    // Same length (17 chars) but different content
    const presented = "wrong-token-16chr";
    expect(presented.length).toBe("secret-token-16ch".length);

    const handler = buildHandler(deps);
    const req = makeReq({ headers: { authorization: `Bearer ${presented}` } });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res._body)).toMatchObject({ error: "unauthorized" });
  });

  it("401s when presented token is shorter than expected (length mismatch)", async () => {
    const { deps } = makeFakeDeps({ expectedToken: "long-secret-token" });
    const handler = buildHandler(deps);
    const req = makeReq({ headers: { authorization: "Bearer short" } });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("401s when presented token is longer than expected", async () => {
    const { deps } = makeFakeDeps({ expectedToken: "short" });
    const handler = buildHandler(deps);
    const req = makeReq({
      headers: { authorization: "Bearer this-is-a-longer-token-than-expected" },
    });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("200s when presented token exactly matches expected", async () => {
    const { deps } = makeFakeDeps({ expectedToken: "correct-token" });
    const handler = buildHandler(deps);
    const req = makeReq({ headers: { authorization: "Bearer correct-token" } });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
  });
});
