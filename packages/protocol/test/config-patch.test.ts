import { describe, it, expect } from "vitest";
import {
  CONFIG_PATCH_NULL,
  ConfigPatchNullSchema,
  ChimeraConfigSchema,
  configPatchValue,
  isConfigPatchNull,
  MCP_TOOL_TABLE,
} from "../src/index.js";

describe("config.patch explicit-null escape", () => {
  it("is a distinguishable string token", () => {
    expect(CONFIG_PATCH_NULL).toBe("$null");
    expect(ConfigPatchNullSchema.safeParse("$null").success).toBe(true);
    expect(ConfigPatchNullSchema.safeParse(null).success).toBe(false);
  });

  it("isConfigPatchNull matches only the token", () => {
    expect(isConfigPatchNull(CONFIG_PATCH_NULL)).toBe(true);
    for (const other of [null, undefined, 0, "", "null", "$NULL", { $null: true }]) {
      expect(isConfigPatchNull(other)).toBe(false);
    }
  });

  it("configPatchValue rewrites ONLY a real null", () => {
    expect(configPatchValue(null)).toBe(CONFIG_PATCH_NULL);
    expect(configPatchValue(120_000)).toBe(120_000);
    expect(configPatchValue(undefined)).toBe(undefined);
    expect(configPatchValue("x")).toBe("x");
  });

  it("the resolved null is a value the config schema accepts", () => {
    const parsed = ChimeraConfigSchema.parse({ providerOverrides: { claude: { compactionThreshold: null } } });
    expect(parsed.providerOverrides?.["claude"]?.compactionThreshold).toBeNull();
    // The UNRESOLVED token must NOT validate — that is what makes a "$null" left sitting in the
    // base config.json (a merge TARGET, never a patch) fail loudly instead of acting as native.
    expect(ChimeraConfigSchema.safeParse({ providerOverrides: { claude: { compactionThreshold: CONFIG_PATCH_NULL } } }).success).toBe(false);
  });

  it("the config_patch tool documents the escape", () => {
    const tool = MCP_TOOL_TABLE.find((t) => t.name === "config_patch");
    expect(tool?.description).toContain(CONFIG_PATCH_NULL);
  });
});
