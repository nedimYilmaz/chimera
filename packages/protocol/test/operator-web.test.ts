import { expect, it } from "vitest";
import { OperatorWebSettingsSchema, OperatorWebPairStartSchema, OperatorWebPairSchema } from "../src/operator-web.js";
import { RPC_CONTRACT } from "../src/contract.js";
it("defaults to read pairing and bounded expiry; only canonical HTTPS external origins are accepted", () => {
  expect(OperatorWebPairStartSchema.parse({ project: "one" }).allowControl).toBe(false);
  expect(OperatorWebPairSchema.parse({ code: "a".repeat(32), deviceLabel: "Phone" }).scope).toBe("read");
  for (const publicOrigin of ["http://example.com", "https://example.com/", "https://user:password@example.com", "https://example.com/path"]) expect(() => OperatorWebSettingsSchema.parse({ publicOrigin })).toThrow();
  expect(() => OperatorWebSettingsSchema.parse({ idleMin: 31 })).toThrow(); expect(() => OperatorWebSettingsSchema.parse({ absoluteH: 25 })).toThrow();
  expect(() => RPC_CONTRACT["operatorweb.pairStart"].request.parse({ project: "one", token: "forged" })).toThrow();
});
