import { describe, expect, it } from "vitest";
import {
  actionHeartbeatReason,
  actionRequiresWake,
  classifyEvent,
  type LanggraphEventKind,
} from "./event-classifier.js";

describe("classifyEvent", () => {
  it("status routes to flow-update-only with noise contextKey", () => {
    expect(classifyEvent({ kind: "status" })).toEqual({
      action: "flow-update-only",
      contextKeyHint: "noise",
    });
  });

  it("milestone routes to light wake", () => {
    expect(classifyEvent({ kind: "milestone" })).toEqual({
      action: "wake-light",
      contextKeyHint: "wake",
    });
  });

  it("decision routes to decision wake", () => {
    expect(classifyEvent({ kind: "decision" })).toEqual({
      action: "wake-decision",
      contextKeyHint: "wake",
    });
  });

  it("terminal routes to terminal wake", () => {
    expect(classifyEvent({ kind: "terminal" })).toEqual({
      action: "wake-terminal",
      contextKeyHint: "wake",
    });
  });

  it("hitl routes to hitl wake", () => {
    expect(classifyEvent({ kind: "hitl" })).toEqual({
      action: "wake-hitl",
      contextKeyHint: "wake",
    });
  });
});

describe("actionRequiresWake", () => {
  it("flow-update-only does not require wake", () => {
    expect(actionRequiresWake("flow-update-only")).toBe(false);
  });

  it.each([["wake-light"], ["wake-decision"], ["wake-terminal"], ["wake-hitl"]] as const)(
    "%s requires wake",
    (action) => {
      expect(actionRequiresWake(action)).toBe(true);
    },
  );
});

describe("actionHeartbeatReason", () => {
  it("prefixes with langgraph-", () => {
    expect(actionHeartbeatReason("wake-decision")).toBe("langgraph-wake-decision");
  });
});

describe("classifyEvent — exhaustive", () => {
  const kinds: LanggraphEventKind[] = ["status", "milestone", "decision", "terminal", "hitl"];

  it("returns a result for every documented kind", () => {
    for (const kind of kinds) {
      const result = classifyEvent({ kind });
      expect(result.action).toBeDefined();
      expect(result.contextKeyHint).toBeDefined();
    }
  });
});
