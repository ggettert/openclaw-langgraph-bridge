/**
 * Tests for F5 — openclaw.plugin.json configSchema completeness.
 *
 * Asserts that every top-level property in the TypeBox `ConfigSchema`
 * exported from `src/index.ts` has a corresponding entry in
 * `openclaw.plugin.json` configSchema.properties.
 *
 * This is a set-equality test: the JSON file should expose every key the
 * TypeBox schema knows about (neither over- nor under-declares).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "./index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pluginJson = JSON.parse(
  readFileSync(join(__dirname, "..", "openclaw.plugin.json"), "utf8"),
) as {
  configSchema?: {
    properties?: Record<string, { type?: string; minimum?: number; maximum?: number }>;
  };
};

describe("F5 — openclaw.plugin.json configSchema coverage", () => {
  // Keys defined in the TypeBox schema (source of truth for the plugin's config).
  const typeboxKeys = new Set(Object.keys(ConfigSchema.properties));

  // Keys declared in the hand-maintained plugin.json manifest.
  const manifestKeys = new Set(Object.keys(pluginJson.configSchema?.properties ?? {}));

  it("plugin.json includes every key from the TypeBox ConfigSchema", () => {
    const missing = [...typeboxKeys].filter((k) => !manifestKeys.has(k));
    expect(
      missing,
      `Keys in TypeBox schema but missing from plugin.json: ${missing.join(", ")}`,
    ).toHaveLength(0);
  });

  it("TypeBox ConfigSchema includes every key from plugin.json (no phantom keys)", () => {
    const extra = [...manifestKeys].filter((k) => !typeboxKeys.has(k));
    expect(
      extra,
      `Keys in plugin.json but absent from TypeBox schema: ${extra.join(", ")}`,
    ).toHaveLength(0);
  });

  it("plugin.json configSchema.properties includes summaryMaxChars", () => {
    expect(manifestKeys.has("summaryMaxChars")).toBe(true);
  });

  it("summaryMaxChars in plugin.json has correct type and range constraints", () => {
    const props = pluginJson.configSchema?.properties?.summaryMaxChars;

    expect(props?.type).toBe("integer");
    expect(props?.minimum).toBe(100);
    expect(props?.maximum).toBe(50000);
  });
});
