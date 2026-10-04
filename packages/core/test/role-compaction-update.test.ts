import { describe, expect, it } from "vitest";
import { Engine } from "@chimera/core/engine";
import { makeEngineHome } from "./helpers.js";
import type { RoleSpec } from "@chimera/protocol";

describe("role compaction threshold updates", () => {
  it("accepts setting and clearing the threshold without resetting other template fields", async () => {
    const e = new Engine({ home: makeEngineHome(), backends: new Map() });
    await e.handle("role.create", { spec: { name: "worker", model: "chosen-model", maxTurns: 123 } });
    const updated = await e.handle("role.update", { name: "worker", patch: { compactionThreshold: 500000 } }) as RoleSpec;
    expect(updated).toMatchObject({ compactionThreshold: 500000, model: "chosen-model", maxTurns: 123 });
    await expect(e.handle("role.update", { name: "worker", patch: { compactionThreshold: 0 } })).rejects.toThrow();
    expect(e.roles.get("worker").compactionThreshold).toBe(500000);
    const cleared = await e.handle("role.update", { name: "worker", patch: { compactionThreshold: null } }) as RoleSpec;
    expect(cleared).toMatchObject({ compactionThreshold: null, model: "chosen-model", maxTurns: 123 });
  });
});
