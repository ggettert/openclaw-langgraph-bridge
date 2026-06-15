import { describe, expect, it } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe("openclaw-langgraph-bridge", () => {
  it("declares the langgraph_dispatch tool", () => {
    const meta = getToolPluginMetadata(entry);
    expect(meta).toBeDefined();
    expect(meta?.tools.map((tool) => tool.name)).toEqual(["langgraph_dispatch"]);
  });

  it("identifies as openclaw-langgraph-bridge", () => {
    const meta = getToolPluginMetadata(entry);
    expect(meta?.id).toBe("openclaw-langgraph-bridge");
  });

  it("declares the expected config keys", () => {
    const meta = getToolPluginMetadata(entry);
    const props = meta?.configSchema?.properties ?? {};
    expect(Object.keys(props).sort()).toEqual([
      "allowedWorkflows",
      "callbackToken",
      "defaultTimeoutMs",
      "langgraphBaseUrl",
    ]);
  });
});
