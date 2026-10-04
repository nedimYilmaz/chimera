import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { chimeraHome } from "@chimera/core/paths";

describe("chimeraHome", () => {
  it("returns CHIMERA_HOME when set", () => {
    expect(chimeraHome({ CHIMERA_HOME: "/tmp/custom-chimera" })).toBe("/tmp/custom-chimera");
  });

  it("falls back to ~/.chimera when CHIMERA_HOME is unset", () => {
    expect(chimeraHome({})).toBe(join(homedir(), ".chimera"));
  });
});
