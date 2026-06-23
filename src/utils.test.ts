import { describe, it, expect } from "vitest";
import { parseMaybeJson } from "./utils.js";

describe("parseMaybeJson", () => {
  it("returns null for null input", () => {
    expect(parseMaybeJson(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseMaybeJson(undefined)).toBeNull();
  });

  it("passes through an already-object value unchanged", () => {
    const obj = { foo: "bar", n: 42 };
    expect(parseMaybeJson(obj)).toBe(obj);
  });

  it("parses a valid JSON string into an object", () => {
    expect(parseMaybeJson('{"key":"value"}')).toEqual({ key: "value" });
  });

  it("returns null for an invalid JSON string", () => {
    expect(parseMaybeJson("not-json")).toBeNull();
  });

  it("returns null when JSON parses to a non-object (e.g. a number string)", () => {
    expect(parseMaybeJson("42")).toBeNull();
  });

  it("returns null when JSON parses to null literal", () => {
    expect(parseMaybeJson("null")).toBeNull();
  });

  it("returns null when JSON parses to an array (arrays are not plain objects)", () => {
    expect(parseMaybeJson("[1,2,3]")).toBeNull();
    expect(parseMaybeJson("[]")).toBeNull();
  });
});
