import { describe, expect, it, vi } from "vitest";
import {
  classifyStreamFrame,
  dispatchAndStream,
  parseSseFrame,
  truncateSummary,
  truncateJsonSummary,
  DEFAULT_SUMMARY_MAX_CHARS,
  type ClassifyResult,
} from "./event-subscriber.js";

function emit(r: ClassifyResult) {
  expect(r.kind).toBe("emit");
  if (r.kind !== "emit") throw new Error("not emit");
  return r.body;
}

describe("parseSseFrame", () => {
  it("parses event + data (LF lines)", () => {
    const f = parseSseFrame('event: metadata\ndata: {"run_id":"r1","attempt":1}');
    expect(f).toEqual({ event: "metadata", data: { run_id: "r1", attempt: 1 } });
  });

  it("parses event + data (CRLF lines) — LangGraph dev server wire format", () => {
    const f = parseSseFrame('event: metadata\r\ndata: {"run_id":"r1","attempt":1}');
    expect(f).toEqual({ event: "metadata", data: { run_id: "r1", attempt: 1 } });
  });

  it("defaults event to message when only data present", () => {
    const f = parseSseFrame('data: {"x":1}');
    expect(f).toEqual({ event: "message", data: { x: 1 } });
  });

  it("returns null on no data lines", () => {
    expect(parseSseFrame("event: foo")).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    expect(parseSseFrame("event: x\ndata: not-json")).toBeNull();
  });
});

describe("classifyStreamFrame — metadata", () => {
  it("captures run_id without emitting an event", () => {
    const r = classifyStreamFrame(
      { event: "metadata", data: { run_id: "r1", attempt: 1 } },
      "flow-1",
      0,
    );
    expect(r.kind).toBe("metadata");
    if (r.kind !== "metadata") throw new Error("expected metadata");
    expect(r.runId).toBe("r1");
  });

  it("skips metadata frame with no run_id", () => {
    const r = classifyStreamFrame(
      { event: "metadata", data: { attempt: 1 } },
      "flow-1",
      0,
    );
    expect(r.kind).toBe("skip");
  });
});

describe("classifyStreamFrame — error", () => {
  it("error frame becomes terminal (failed)", () => {
    const body = emit(
      classifyStreamFrame(
        {
          event: "error",
          data: { error: "KeyError", message: "'ticket_id'" },
        },
        "flow-1",
        5,
      ),
    );
    expect(body.kind).toBe("terminal");
    expect(body.title).toContain("error: KeyError");
    expect(body.summary).toBe("'ticket_id'");
    expect(body.seq).toBe(5);
  });
});

describe("classifyStreamFrame — updates", () => {
  it("raw {node: delta} body becomes milestone", () => {
    const body = emit(
      classifyStreamFrame(
        { event: "updates", data: { coder: { tokens: 42 } } },
        "flow-1",
        2,
      ),
    );
    expect(body.kind).toBe("milestone");
    expect(body.title).toBe("node:coder");
    expect(body.summary).toContain("tokens");
    expect(body.data).toMatchObject({ node: "coder" });
  });

  it("v2 StreamPart wrapper {type:'updates', data:{...}} is unwrapped", () => {
    const body = emit(
      classifyStreamFrame(
        { event: "updates", data: { type: "updates", ns: [], data: { coder: { ok: true } } } },
        "flow-1",
        3,
      ),
    );
    expect(body.kind).toBe("milestone");
    expect(body.title).toBe("node:coder");
  });

  // NOTE: the suppression of synthetic-terminal-on-close when a hitl was
  // already emitted lives in dispatchAndStream's frame loop, not in
  // classifyStreamFrame. That behavior is exercised in the live smoke
  // (intermittent test issue — trace 2026-06-15 21:45 UTC) and would be nice to
  // refactor for unit testability later.

  it("updates with node='__interrupt__' is classified as hitl (regression: 2026-06-15)", () => {
    const body = emit(
      classifyStreamFrame(
        {
          event: "updates",
          data: {
            __interrupt__: [
              { id: "int-1", value: { prompt: "approve merge?" } },
            ],
          },
        },
        "flow-1",
        9,
      ),
    );
    expect(body.kind).toBe("hitl");
    expect(body.interrupt_id).toBe("int-1");
    expect(body.summary).toBe("approve merge?");
  });

  it("__interrupt__ with plain-string value falls back to that string as prompt", () => {
    const body = emit(
      classifyStreamFrame(
        {
          event: "updates",
          data: { __interrupt__: [{ id: "int-2", value: "yes/no?" }] },
        },
        "flow-1",
        10,
      ),
    );
    expect(body.kind).toBe("hitl");
    expect(body.summary).toBe("yes/no?");
  });

  it("__interrupt__ missing id synthesizes a seq-based one", () => {
    const body = emit(
      classifyStreamFrame(
        {
          event: "updates",
          data: { __interrupt__: [{ value: { prompt: "x" } }] },
        },
        "flow-1",
        11,
      ),
    );
    expect(body.kind).toBe("hitl");
    expect(body.interrupt_id).toBe("seq-11");
  });

  it("empty updates payload is skipped", () => {
    const r = classifyStreamFrame(
      { event: "updates", data: {} },
      "flow-1",
      0,
    );
    expect(r.kind).toBe("skip");
  });
});

describe("classifyStreamFrame — custom (workflow author escape hatch)", () => {
  it("custom with kind=decision passes through as decision", () => {
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: {
            kind: "decision",
            title: "needs-input",
            summary: "which target env?",
          },
        },
        "flow-1",
        7,
      ),
    );
    expect(body.kind).toBe("decision");
    expect(body.title).toBe("needs-input");
    expect(body.summary).toBe("which target env?");
  });

  it("custom with kind=hitl carries interrupt_id", () => {
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: {
            kind: "hitl",
            title: "approval",
            summary: "approve deploy?",
            interrupt_id: "i-42",
          },
        },
        "flow-1",
        8,
      ),
    );
    expect(body.kind).toBe("hitl");
    expect(body.interrupt_id).toBe("i-42");
  });

  it("custom with unknown kind degrades to status", () => {
    const body = emit(
      classifyStreamFrame(
        { event: "custom", data: { kind: "totally-made-up", note: "hi" } },
        "flow-1",
        9,
      ),
    );
    expect(body.kind).toBe("status");
  });

  it("native fleet vocabulary {phase, event=started, ...} -> milestone", () => {
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: {
            phase: "designer",
            event: "started",
            ticket_id: "TASK-7",
            product_spec_path: "feature/TASK-7/product-spec.md",
            revision_count: 0,
          },
        },
        "flow-1",
        12,
      ),
    );
    expect(body.kind).toBe("milestone");
    expect(body.title).toBe("designer:started");
    expect(body.summary).toContain("TASK-7");
    expect(body.data).toMatchObject({ phase: "designer", event: "started" });
  });

  it("native fleet {phase, event=finished, pr_url} -> milestone w/ pr summary", () => {
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: {
            phase: "coder",
            event: "finished",
            ticket_id: "TASK-7",
            pr_url: "https://github.com/<your-org>/your-target-repo/pull/42",
            branch: "feature/TASK-7",
          },
        },
        "flow-1",
        13,
      ),
    );
    expect(body.kind).toBe("milestone");
    expect(body.title).toBe("coder:finished");
    expect(body.summary).toContain("TASK-7");
    expect(body.summary).toContain("pull/42");
  });

  it("native fleet {phase, event=failed, ...} -> terminal", () => {
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: { phase: "coder", event: "failed", error: "compile error" },
        },
        "flow-1",
        14,
      ),
    );
    expect(body.kind).toBe("terminal");
    expect(body.title).toBe("coder:failed");
  });

  it("native fleet {phase, event=progress, ...} -> status", () => {
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: { phase: "reviewer", event: "progress", note: "halfway" },
        },
        "flow-1",
        15,
      ),
    );
    expect(body.kind).toBe("status");
    expect(body.title).toBe("reviewer:progress");
  });

  it("explicit kind beats native fleet vocabulary", () => {
    // If a workflow emits {kind: "decision", phase: "...", event: "..."},
    // the explicit kind wins over the phase/event translation.
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: {
            kind: "decision",
            phase: "designer",
            event: "started",
            title: "escalation",
            summary: "needs human",
          },
        },
        "flow-1",
        16,
      ),
    );
    expect(body.kind).toBe("decision");
    expect(body.title).toBe("escalation");
  });

  it("custom without kind degrades to status", () => {
    const body = emit(
      classifyStreamFrame(
        { event: "custom", data: { progress: 50 } },
        "flow-1",
        10,
      ),
    );
    expect(body.kind).toBe("status");
    expect(body.summary).toContain("progress");
  });

  // -------------------------------------------------------------------------
  // Phase event contract (#42) — explicit summary + field propagation tests
  // -------------------------------------------------------------------------

  it("explicit summary field preferred over heuristic when present", () => {
    // When the workflow author provides data.summary, that string is used
    // instead of the summarizeFleetData heuristic.
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: {
            phase: "coder",
            event: "started",
            ticket_id: "BINGO-42",
            summary: "analyzing spec for BINGO-42",
          },
        },
        "flow-1",
        20,
      ),
    );
    expect(body.kind).toBe("milestone");
    expect(body.title).toBe("coder:started");
    // Should use the explicit summary, not the heuristic (ticket_id alone)
    expect(body.summary).toBe("analyzing spec for BINGO-42");
  });

  it("heuristic summary used when explicit summary field is absent", () => {
    // Legacy payload without data.summary falls back to summarizeFleetData.
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: {
            phase: "coder",
            event: "finished",
            ticket_id: "BINGO-42",
            pr_url: "https://github.com/acme/repo/pull/99",
            // no summary field
          },
        },
        "flow-1",
        21,
      ),
    );
    expect(body.kind).toBe("milestone");
    expect(body.title).toBe("coder:finished");
    // Heuristic includes ticket_id and pr_url
    expect(body.summary).toContain("BINGO-42");
    expect(body.summary).toContain("pull/99");
  });

  it("verdict and pr_url propagate into body.data", () => {
    // Ensure verdict, pr_url, and branch flow through to body.data so
    // the agent's wake handler can read them without re-parsing.
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: {
            phase: "reviewer",
            event: "finished",
            ticket_id: "BINGO-42",
            summary: "verdict: approve",
            pr_url: "https://github.com/acme/repo/pull/99",
            branch: "feature/BINGO-42",
            verdict: "approve",
          },
        },
        "flow-1",
        22,
      ),
    );
    expect(body.kind).toBe("milestone");
    expect(body.summary).toBe("verdict: approve");
    // pr_url, branch, verdict must be present in body.data
    const d = body.data as Record<string, unknown>;
    expect(d.verdict).toBe("approve");
    expect(d.pr_url).toBe("https://github.com/acme/repo/pull/99");
    expect(d.branch).toBe("feature/BINGO-42");
  });

  // -------------------------------------------------------------------------
  // M2: typed fast path via isPhaseEventPayload
  // -------------------------------------------------------------------------

  it("typed fast path (isPhaseEventPayload=true) uses summary verbatim and propagates error field", () => {
    // When the payload has all required PhaseEventPayload fields, the typed
    // fast path is taken: summary is used verbatim, all optional fields
    // (including error) are preserved in body.data.
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: {
            schema_version: 1,
            phase: "coder",
            event: "failed",
            ticket_id: "BINGO-99",
            summary: "RuntimeError: git push rejected",
            pr_url: "https://github.com/acme/repo/pull/7",
            error: "RuntimeError: git push rejected\nfull traceback ...",
          },
        },
        "flow-fast",
        30,
      ),
    );
    // failed event maps to terminal
    expect(body.kind).toBe("terminal");
    expect(body.title).toBe("coder:failed");
    // summary comes from the typed field, not heuristic
    expect(body.summary).toBe("RuntimeError: git push rejected");
    // error field preserved in body.data
    const d = body.data as Record<string, unknown>;
    expect(d.error).toContain("RuntimeError");
    expect(d.pr_url).toBe("https://github.com/acme/repo/pull/7");
    expect(d.ticket_id).toBe("BINGO-99");
  });

  it("typed fast path (isPhaseEventPayload=true) for started event -> milestone", () => {
    // Validates that a full PhaseEventPayload with schema_version takes the
    // fast path and correctly classifies started -> milestone.
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: {
            schema_version: 1,
            phase: "merge_gate",
            event: "started",
            ticket_id: "BINGO-100",
            summary: "waiting for human approval",
          },
        },
        "flow-fast",
        31,
      ),
    );
    expect(body.kind).toBe("milestone");
    expect(body.title).toBe("merge_gate:started");
    expect(body.summary).toBe("waiting for human approval");
  });

  // -------------------------------------------------------------------------
  // M1: single truncation source — no double truncation
  // -------------------------------------------------------------------------

  it("explicit summary is NOT pre-truncated at 500 chars (processEvent owns truncation)", () => {
    // A summary longer than 500 chars should pass through translateFleetVocabulary
    // verbatim. The caller (processEvent in webhook-handler.ts) applies the
    // user-configured summaryMaxChars cap. Double-truncation at 500 here
    // would override summaryMaxChars < 500 and silently cap above it.
    const longSummary = "x".repeat(600); // 600 chars > 500
    const body = emit(
      classifyStreamFrame(
        {
          event: "custom",
          data: {
            schema_version: 1,
            phase: "coder",
            event: "started",
            ticket_id: "BINGO-trunc",
            summary: longSummary,
          },
        },
        "flow-trunc",
        32,
      ),
    );
    // Summary reaches the classifier result without being cut at 500.
    // processEvent (not tested here) will apply summaryMaxChars later.
    expect(body.summary).toBe(longSummary);
    expect(body.summary!.length).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// truncateSummary / truncateJsonSummary
// ---------------------------------------------------------------------------

describe("truncateSummary", () => {
  it("returns short strings verbatim", () => {
    const s = "hello world";
    expect(truncateSummary(s)).toBe(s);
  });

  it("truncates long strings at last whitespace and appends ellipsis suffix", () => {
    // Build a string that is just over the default cap
    const prefix = "word ".repeat(900); // 900 * 5 = 4500 chars
    const result = truncateSummary(prefix);
    expect(result.endsWith(" \u2026[truncated]")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_SUMMARY_MAX_CHARS + 13); // suffix
    // Cut must not end with a partial word — last char before suffix is a space (we cut at the
    // trailing space of the last whole word)
    const beforeSuffix = result.slice(0, result.lastIndexOf(" \u2026"));
    expect(beforeSuffix.endsWith(" ")).toBe(false); // trailing whitespace stripped by cut logic
  });

  it("respects a custom maxChars argument", () => {
    const result = truncateSummary("abcdefghijklmnopqrstuvwxyz", 10);
    // No whitespace in input → hard-cuts at 10 chars then appends suffix
    expect(result).toBe("abcdefghij \u2026[truncated]");
  });
});

describe("truncateJsonSummary", () => {
  it("returns compact JSON verbatim when it fits within the cap", () => {
    const data = { key: "value", n: 42 };
    const result = truncateJsonSummary(data);
    expect(result).toBe(JSON.stringify(data));
  });

  it("truncates long JSON at whitespace — does NOT produce broken-quote output", () => {
    // Construct an object whose compact JSON serialisation is > DEFAULT_SUMMARY_MAX_CHARS.
    // The long value has no spaces, so if we sliced bytes we'd cut mid-string.
    const data = {
      branch: "feature/BINGO-" + "a".repeat(5000),
      tokens: 42,
    };
    const result = truncateJsonSummary(data);
    expect(result.endsWith(" \u2026[truncated]")).toBe(true);
    // No unclosed double-quote: the part before the suffix must not end with `"
    const beforeSuffix = result.slice(0, result.lastIndexOf(" \u2026"));
    // Every " in beforeSuffix must be matched (count must be even, or last char must not be a lone \")
    // Simpler check: last char before the ellipsis must be whitespace or punctuation, not a quote
    // that would imply a half-open JSON string.
    expect(beforeSuffix.endsWith('"')).toBe(false);
  });

  it("long JSON produces a result that does not end with a partial quoted value", () => {
    // A second guard: the truncated result should never look like `"some/path/
    // (i.e. an open quote that was never closed before the truncation marker).
    const data = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `key${i}`,
        "v".repeat(500),
      ]),
    );
    const result = truncateJsonSummary(data, 1000);
    expect(result.endsWith(" \u2026[truncated]")).toBe(true);
    // Count open-vs-close quotes in the part before the suffix
    const beforeSuffix = result.slice(0, result.lastIndexOf(" \u2026"));
    // If the cut happened between tokens (at whitespace), the last non-space
    // character before the ellipsis is never an unclosed `"` followed immediately
    // by alphanumeric content (i.e. a half-open string).
    expect(beforeSuffix.endsWith('"')).toBe(false);
  });

  it("classifyStreamFrame — long updates delta is truncated without breaking quotes (regression: BINGO-darkmode)", () => {
    // Simulate the original bug: branch name + reviewer blob > 280 chars.
    // After the fix the summary should still be readable and never end mid-quote.
    const delta = {
      branch: "feature/BINGO-darkmode-build-41830",
      reviewer_notes: "x".repeat(5000),
    };
    const result = classifyStreamFrame(
      { event: "updates", data: { reviewer: delta } },
      "flow-1",
      0,
    );
    expect(result.kind).toBe("emit");
    if (result.kind !== "emit") throw new Error("not emit");
    // Summary must be present and not end with an unclosed quote
    expect(result.body.summary).toBeDefined();
    const summary = result.body.summary!;
    expect(summary.endsWith('"')).toBe(false);
    // If truncation happened, it must carry the marker
    if (summary.includes("\u2026[truncated]")) {
      expect(summary.endsWith(" \u2026[truncated]")).toBe(true);
    }
  });
});

describe("classifyStreamFrame — skip", () => {
  it("messages, values, events are skipped", () => {
    expect(
      classifyStreamFrame({ event: "messages", data: {} }, "f", 0).kind,
    ).toBe("skip");
    expect(
      classifyStreamFrame({ event: "values", data: {} }, "f", 0).kind,
    ).toBe("skip");
    expect(
      classifyStreamFrame({ event: "events", data: {} }, "f", 0).kind,
    ).toBe("skip");
  });
});

describe("dispatchAndStream — request body shape", () => {
  // Helper: capture the fetch body without actually streaming.
  function makeCapturingFetch() {
    const capture: { url?: string; body?: unknown } = {};
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      capture.url = url;
      capture.body = init.body ? JSON.parse(init.body as string) : null;
      // Return a Response that closes immediately with no body — the
      // subscriber will treat it as an error, which is fine: we only
      // care that the request was shaped correctly.
      return new Response("", { status: 200 });
    });
    return { fetchImpl, capture };
  }

  it("initial dispatch sends `input`, not `command`", async () => {
    const { fetchImpl, capture } = makeCapturingFetch();
    dispatchAndStream({
      baseUrl: "http://lg.test",
      threadId: "t1",
      flowId: "f1",
      assistantId: "fleet",
      input: { ticket_id: "X" },
      metadata: { foo: "bar" },
      handlers: { onEvent: () => {} },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // Let microtasks settle so the body is captured.
    await new Promise((r) => setTimeout(r, 5));
    expect(capture.url).toMatch(/\/threads\/t1\/runs\/stream$/);
    const body = capture.body as Record<string, unknown>;
    expect(body.assistant_id).toBe("fleet");
    expect(body.input).toEqual({ ticket_id: "X" });
    expect("command" in body).toBe(false);
    expect(body.stream_mode).toEqual(["updates", "custom"]);
  });

  it("resume dispatch sends `command`, not `input`", async () => {
    const { fetchImpl, capture } = makeCapturingFetch();
    dispatchAndStream({
      baseUrl: "http://lg.test",
      threadId: "t1",
      flowId: "f1",
      assistantId: "fleet",
      command: { resume: { decision: "approve", feedback: "" } },
      metadata: { openclaw_resume_source: "tool:langgraph_resume" },
      handlers: { onEvent: () => {} },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await new Promise((r) => setTimeout(r, 5));
    const body = capture.body as Record<string, unknown>;
    expect(body.assistant_id).toBe("fleet");
    expect(body.command).toEqual({ resume: { decision: "approve", feedback: "" } });
    expect("input" in body).toBe(false);
    expect(body.stream_mode).toEqual(["updates", "custom"]);
  });

  it("command takes precedence — input is ignored when command is set", async () => {
    const { fetchImpl, capture } = makeCapturingFetch();
    dispatchAndStream({
      baseUrl: "http://lg.test",
      threadId: "t1",
      flowId: "f1",
      assistantId: "fleet",
      input: { ignored: true },
      command: { resume: "x" },
      handlers: { onEvent: () => {} },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await new Promise((r) => setTimeout(r, 5));
    const body = capture.body as Record<string, unknown>;
    expect(body.command).toEqual({ resume: "x" });
    expect("input" in body).toBe(false);
  });
});
