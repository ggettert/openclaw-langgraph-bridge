import { describe, expect, it } from "vitest";
import {
  classifyStreamFrame,
  parseSseFrame,
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
  // (see BINGO-INT trace 2026-06-15 21:45 UTC) and would be nice to
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
            ticket_id: "BINGO-7",
            product_spec_path: "feature/BINGO-7/product-spec.md",
            revision_count: 0,
          },
        },
        "flow-1",
        12,
      ),
    );
    expect(body.kind).toBe("milestone");
    expect(body.title).toBe("designer:started");
    expect(body.summary).toContain("BINGO-7");
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
            ticket_id: "BINGO-7",
            pr_url: "https://github.com/ggettert/aidlc-sandbox/pull/42",
            branch: "feature/BINGO-7",
          },
        },
        "flow-1",
        13,
      ),
    );
    expect(body.kind).toBe("milestone");
    expect(body.title).toBe("coder:finished");
    expect(body.summary).toContain("BINGO-7");
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
