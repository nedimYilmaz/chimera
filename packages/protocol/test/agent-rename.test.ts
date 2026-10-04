import { describe, expect, it } from "vitest";
import { AgentRenameParamsSchema } from "@chimera/protocol";

describe("AgentRenameParamsSchema", () => {
  it("requires a non-empty trimmed displayLabel", () => {
    expect(() => AgentRenameParamsSchema.parse({ agentId: "a1", displayLabel: "  " })).toThrow();
    expect(AgentRenameParamsSchema.parse({ agentId: "a1", displayLabel: " gitops PR 246 " }).displayLabel)
      .toBe("gitops PR 246");
  });
});
