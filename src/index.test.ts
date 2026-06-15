import { describe, expect, it } from "vitest";
import entry from "./index.js";

/**
 * Phase 2 onward, we ship via definePluginEntry (not defineToolPlugin),
 * so the upstream `openclaw plugins build` builder can't introspect the
 * entry — we hand-maintain `openclaw.plugin.json`. These tests assert
 * the bare shape we DO control programmatically.
 */
describe("openclaw-langgraph-bridge entry", () => {
  it("identifies as openclaw-langgraph-bridge", () => {
    expect(entry.id).toBe("openclaw-langgraph-bridge");
  });

  it("exposes a register function", () => {
    expect(typeof entry.register).toBe("function");
  });
});
