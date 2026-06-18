import { describe, expect, it } from "vitest";
import { isPhaseEventPayload } from "./phase-event.js";

describe("isPhaseEventPayload", () => {
  it("returns true for a minimal valid payload", () => {
    expect(
      isPhaseEventPayload({
        phase: "coder",
        event: "started",
        ticket_id: "BINGO-42",
        summary: "analyzing spec",
      }),
    ).toBe(true);
  });

  it("returns true for a fully-specified payload", () => {
    expect(
      isPhaseEventPayload({
        schema_version: 1,
        phase: "reviewer",
        event: "finished",
        ticket_id: "BINGO-42",
        summary: "verdict: approve",
        pr_url: "https://github.com/acme/repo/pull/99",
        branch: "feature/BINGO-42",
        verdict: "approve",
        error: null,
        details: { revision_count: 0 },
      }),
    ).toBe(true);
  });

  it("returns true for failed event with error field", () => {
    expect(
      isPhaseEventPayload({
        schema_version: 1,
        phase: "coder",
        event: "failed",
        ticket_id: "BINGO-42",
        summary: "RuntimeError: git push rejected: non-fast-forward",
        error: "RuntimeError: git push rejected: non-fast-forward",
      }),
    ).toBe(true);
  });

  it("returns false when phase is missing", () => {
    expect(
      isPhaseEventPayload({
        event: "started",
        ticket_id: "BINGO-42",
        summary: "analyzing spec",
      }),
    ).toBe(false);
  });

  it("returns false when ticket_id is missing", () => {
    expect(
      isPhaseEventPayload({
        phase: "coder",
        event: "started",
        summary: "analyzing spec",
      }),
    ).toBe(false);
  });

  it("returns false when summary is missing", () => {
    expect(
      isPhaseEventPayload({
        phase: "coder",
        event: "started",
        ticket_id: "BINGO-42",
      }),
    ).toBe(false);
  });

  it("returns false when summary is an empty string", () => {
    expect(
      isPhaseEventPayload({
        phase: "coder",
        event: "started",
        ticket_id: "BINGO-42",
        summary: "",
      }),
    ).toBe(false);
  });

  it("returns false for an unrecognised event name", () => {
    expect(
      isPhaseEventPayload({
        phase: "coder",
        event: "progress",       // not in started|finished|failed
        ticket_id: "BINGO-42",
        summary: "halfway there",
      }),
    ).toBe(false);
  });

  it("returns false for a non-object input (string)", () => {
    expect(isPhaseEventPayload("coder:started")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isPhaseEventPayload(null)).toBe(false);
  });

  it("returns false for an empty object", () => {
    expect(isPhaseEventPayload({})).toBe(false);
  });

  it("returns false when phase is a number instead of string", () => {
    expect(
      isPhaseEventPayload({
        phase: 42,
        event: "started",
        ticket_id: "BINGO-42",
        summary: "analyzing spec",
      }),
    ).toBe(false);
  });
});
