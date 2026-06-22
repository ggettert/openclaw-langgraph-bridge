import { describe, expect, it } from "vitest";
import { normalizeResumePayload } from "./index.js";

describe("normalizeResumePayload — HITL keywords -> structured shape", () => {
  it.each([
    ["approve", { decision: "approve", feedback: "" }],
    ["Approve", { decision: "approve", feedback: "" }],
    ["yes", { decision: "approve", feedback: "" }],
    ["LGTM", { decision: "approve", feedback: "" }],
    ["block", { decision: "block_revise", feedback: "" }],
    ["block_revise", { decision: "block_revise", feedback: "" }],
    ["no", { decision: "block_revise", feedback: "" }],
    ["block_abort", { decision: "block_abort", feedback: "" }],
    ["abort", { decision: "block_abort", feedback: "" }],
    ["cancel", { decision: "block_abort", feedback: "" }],
    ["extend", { decision: "extend", feedback: "" }],
  ])("plain '%s' becomes structured decision", (input, expected) => {
    expect(normalizeResumePayload(input)).toEqual(expected);
  });

  it("'block_revise: cleanup the tests' splits decision + feedback", () => {
    expect(normalizeResumePayload("block_revise: cleanup the tests")).toEqual({
      decision: "block_revise",
      feedback: "cleanup the tests",
    });
  });

  it("'block: more comments' aliases to block_revise w/ feedback", () => {
    expect(normalizeResumePayload("block: more comments")).toEqual({
      decision: "block_revise",
      feedback: "more comments",
    });
  });

  it("non-keyword strings pass through unchanged", () => {
    expect(normalizeResumePayload("just some plain feedback")).toBe("just some plain feedback");
  });

  it("objects pass through unchanged", () => {
    const obj = { decision: "approve", feedback: "" };
    expect(normalizeResumePayload(obj)).toBe(obj);
  });

  it("numbers pass through unchanged", () => {
    expect(normalizeResumePayload(42)).toBe(42);
  });

  it("empty / whitespace-only strings pass through unchanged", () => {
    expect(normalizeResumePayload("")).toBe("");
    expect(normalizeResumePayload("   ")).toBe("   ");
  });
});
