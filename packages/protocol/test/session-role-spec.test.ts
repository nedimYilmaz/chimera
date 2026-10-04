import { describe, expect, it } from "vitest";
import { RoleSpecSchema, BUILTIN_ROLES } from "../src/index.js";

describe("RoleSpecSchema", () => {
  it("defaults skills to an empty array", () => {
    expect(RoleSpecSchema.parse({ name: "blank" }).skills).toEqual([]);
  });
  it("rejects an unknown key (closed shape)", () => {
    expect(() => RoleSpecSchema.parse({ name: "x", bogus: 1 })).toThrow();
  });
});

describe("BUILTIN_ROLES", () => {
  it("has exactly aws/review/triage/blank, each a valid RoleSpec", () => {
    expect(BUILTIN_ROLES.map((r) => r.name).sort()).toEqual(["aws", "blank", "review", "triage"]);
    for (const r of BUILTIN_ROLES) expect(() => RoleSpecSchema.parse(r)).not.toThrow();
  });
  it("aws role's instructions name the mutation gate, never claim to bypass it", () => {
    const aws = BUILTIN_ROLES.find((r) => r.name === "aws")!;
    expect(aws.instructions ?? "").toMatch(/mutation gate|classifyCloudMutation/i);
  });
  it("aws role does not unconditionally promise the mutation gate — carves out codex full-access", () => {
    // AWS-ROLE-TELLS-CODEX-A-LIE: decidePermission (and thus the cloud-mutation gate) never
    // runs for a codex "full" spawn (see CODEX-GATE-EXPOSURE) — the role text must say so
    // instead of promising a mechanism that will not fire for that provider/profile.
    const aws = BUILTIN_ROLES.find((r) => r.name === "aws")!;
    const text = aws.instructions ?? "";
    expect(text).toMatch(/mutation gate|classifyCloudMutation/i);
    expect(text.toLowerCase()).toContain("codex");
    expect(text.toLowerCase()).toContain("full");
    expect(text.toLowerCase()).toMatch(/cannot fire|no permission hook/);
  });
  it("review role carries the real installed skill ids", () => {
    const review = BUILTIN_ROLES.find((r) => r.name === "review")!;
    expect(review.skills).toContain("code-review:ai-review-agentic");
    expect(review.skills).toContain("security-reviewer:review");
  });
});
