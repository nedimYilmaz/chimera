import { isPeerMethod } from "../src/index.js";
import { it, expect } from "vitest";
import { ContextLinkCreateSchema, ContextLinkListSchema, ContextLinkTargetSchema } from "../src/context-links.js";
it("context requests are strict, stable and local; caller authority cannot be declared in request data", () => {
  const note = { from: { kind: "note-snapshot", ref: "a" }, toAgentId: "b", text: "explicit preview" };
  expect(ContextLinkCreateSchema.safeParse(note).success).toBe(true);
  for (const patch of [{ operator: true }, { trustedOperator: true }, { trustedLocalClient: true }, { createdBy: "operator" }]) expect(ContextLinkCreateSchema.safeParse({ ...note, ...patch }).success).toBe(false);
  expect(ContextLinkListSchema.safeParse({ toAgentId: "peer:b" }).success).toBe(false);
  expect(ContextLinkTargetSchema.safeParse({ id: "a" }).success).toBe(false);
});
it("context links are excluded from the authenticated peer method allowlist", async () => {
  for (const method of ["contextlink.create", "contextlink.list", "contextlink.get", "contextlink.revoke"]) expect(isPeerMethod(method)).toBe(false);
});
