import { describe, expect, it } from "vitest";
import { formatInspect } from "./inspect-formatter.js";

describe("formatInspect", () => {
  it("returns a polite no-match message when flow is null", () => {
    expect(formatInspect({ flow: null })).toBe("No matching LangGraph flow found in this session.");
  });

  it("formats a running flow with state_json fields", () => {
    const out = formatInspect({
      flow: {
        flowId: "f-1",
        status: "running",
        goal: "LangGraph workflow: fleet",
        currentStep: "running",
        revision: 1,
        stateJson: {
          workflow: "fleet",
          langgraph_thread_id: "t-1",
          langgraph_run_id: "r-1",
        },
      },
    });
    expect(out).toContain("Flow: f-1");
    expect(out).toContain("status: running");
    expect(out).toContain("workflow: fleet");
    expect(out).toContain("thread_id: t-1");
    expect(out).toContain("run_id: r-1");
  });

  it("formats a waiting flow with interrupt prompt", () => {
    const out = formatInspect({
      flow: {
        flowId: "f-2",
        status: "waiting",
        currentStep: "interrupt",
        waitJson: {
          interrupt_id: "int-9",
          prompt: "approve merge?",
        },
      },
    });
    expect(out).toContain("status: waiting");
    expect(out).toContain("interrupt_id: int-9");
    expect(out).toContain("prompt: approve merge?");
  });

  it("parses stringified JSON in stateJson/waitJson", () => {
    const out = formatInspect({
      flow: {
        flowId: "f-3",
        status: "waiting",
        stateJson: JSON.stringify({ workflow: "fleet" }),
        waitJson: JSON.stringify({ interrupt_id: "x", prompt: "p" }),
      },
    });
    expect(out).toContain("workflow: fleet");
    expect(out).toContain("interrupt_id: x");
  });

  it("truncates long prompts at 500 chars", () => {
    const out = formatInspect({
      flow: {
        flowId: "f-4",
        status: "waiting",
        waitJson: { prompt: "p".repeat(900) },
      },
    });
    expect(out).toMatch(/prompt: p+\u2026/);
    const promptLine = out.split("\n").find((l) => l.includes("prompt:"))!;
    // 500 chars + ellipsis + "    prompt: " prefix
    expect(promptLine.length).toBeLessThanOrEqual(520);
  });

  it("includes task summary when provided", () => {
    const out = formatInspect({
      flow: {
        flowId: "f-5",
        status: "running",
      },
      taskSummary: "2 tasks completed, 1 in flight",
    });
    expect(out).toContain("Task summary:");
    expect(out).toContain("2 tasks completed, 1 in flight");
  });

  it("formats a terminal flow with terminal_title/summary", () => {
    const out = formatInspect({
      flow: {
        flowId: "f-6",
        status: "succeeded",
        endedAt: 1781560000000,
        stateJson: {
          terminal_title: "error: KeyError",
          terminal_summary: "'ticket_id'",
        },
      },
    });
    expect(out).toContain("status: succeeded");
    expect(out).toContain("terminal_title: error: KeyError");
    expect(out).toContain("ended_at: 2026-");
  });
});
