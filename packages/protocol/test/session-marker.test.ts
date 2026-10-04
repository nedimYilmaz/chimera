import { describe, it, expect } from "vitest";
import { AgentSpecSchema } from "@chimera/protocol";

describe("AgentSpec session flag (session tier)", () => {
  it("defaults session to false", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp" });
    expect(spec.session).toBe(false);
  });

  it("accepts an explicit session:true spawn", () => {
    const spec = AgentSpecSchema.parse({ prompt: "x", cwd: "/tmp", session: true });
    expect(spec.session).toBe(true);
  });
});
