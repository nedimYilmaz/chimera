import { describe, it, expect } from "vitest";
import { parseCodexCommand } from "@chimera/core/backends/codex-commands";

describe("parseCodexCommand /compact", () => {
  it("parses a bare /compact", () => {
    expect(parseCodexCommand("/compact")).toEqual({ name: "compact" });
  });

  it("refuses instructions after /compact instead of silently dropping them", () => {
    expect(() => parseCodexCommand("/compact keep decisions")).toThrow("does not accept instructions");
  });
});
