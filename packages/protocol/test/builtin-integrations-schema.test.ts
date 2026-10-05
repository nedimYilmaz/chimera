import { describe, expect, it } from "vitest";
import {
  BuiltInStatusSchema, BuiltInsInstallParamsSchema, BuiltInsStatusResultSchema, McpBuiltInSchema, McpStoreEntrySchema,
} from "@chimera/protocol";

// mcpstore.json written before the provenance marker existed must keep loading unchanged -- the
// registry fails fast on a corrupt file, so a schema that rejected old entries would brick startup.
describe("built-in provenance schema", () => {
  const legacy = { name: "chimera-browser", command: "/opt/node", args: ["cli.js"], sessionMode: "agent" };

  it("parses an entry written before the marker existed, with no marker", () => {
    const e = McpStoreEntrySchema.parse(legacy);
    expect(e.type === "stdio" && e.builtIn).toBeUndefined();
  });
  it("round-trips a marked entry", () => {
    const e = McpStoreEntrySchema.parse({ ...legacy, builtIn: { id: "chimera-browser", version: "0.0.83" } });
    expect(McpStoreEntrySchema.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });
  it.each([
    ["unknown id", { id: "evil", version: "1" }],
    ["empty version", { id: "laya", version: "" }],
    ["extra key", { id: "laya", version: "1", trusted: true }],
  ])("rejects a malformed marker: %s", (_n, builtIn) => {
    expect(McpBuiltInSchema.safeParse(builtIn).success).toBe(false);
    expect(McpStoreEntrySchema.safeParse({ ...legacy, builtIn }).success).toBe(false);
  });
});

describe("built-in status RPC schemas", () => {
  it("accepts every state with the honest provisioning split", () => {
    const ok = BuiltInsStatusResultSchema.parse({
      managed: true,
      integrations: [
        { id: "laya", state: "not-installed", provisioning: "managed-download", modelAssets: "downloaded-on-first-use" },
        { id: "chimera-browser", state: "ready", provisioning: "bundled", version: "0.0.83" },
        { id: "chimera-desktop", state: "unsupported-platform", provisioning: "bundled", reason: "no build for linux-arm64" },
      ],
    });
    expect(ok.integrations).toHaveLength(3);
  });
  it("is strict, so a status can never smuggle unvetted fields to the UI", () => {
    expect(BuiltInStatusSchema.safeParse({ id: "laya", state: "ready", provisioning: "bundled", path: "/x" }).success).toBe(false);
    expect(BuiltInStatusSchema.safeParse({ id: "laya", state: "ready", provisioning: "bundled", modelAssets: "bundled" }).success).toBe(false);
    expect(BuiltInsStatusResultSchema.safeParse({ managed: false, integrations: [], extra: 1 }).success).toBe(false);
  });
  it("only Laya can be installed on demand", () => {
    expect(BuiltInsInstallParamsSchema.safeParse({ id: "laya" }).success).toBe(true);
    expect(BuiltInsInstallParamsSchema.safeParse({ id: "chimera-desktop" }).success).toBe(false);
    expect(BuiltInsInstallParamsSchema.safeParse({}).success).toBe(false);
  });
});
