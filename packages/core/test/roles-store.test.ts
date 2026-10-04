import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RoleStore } from "../src/roles-store.js";

describe("RoleStore", () => {
  it("seeds the 4 builtins on first construction", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-roles-"));
    const store = new RoleStore(dir);
    expect(store.list().map((r) => r.name).sort()).toEqual(["aws", "blank", "review", "triage"]);
  });

  it("persists a custom role across reconstruction, and does not clobber a user edit to a builtin name on reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-roles-"));
    const s1 = new RoleStore(dir);
    s1.create({ name: "oncall", instructions: "custom" });
    s1.update("blank", { instructions: "edited" });
    const s2 = new RoleStore(dir);
    expect(s2.get("oncall").instructions).toBe("custom");
    expect(s2.get("blank").instructions).toBe("edited");
    expect(s2.list().map((r) => r.name).sort()).toEqual(["aws", "blank", "oncall", "review", "triage"]);
  });

  it("rejects a duplicate name and an unknown name on update/delete", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-roles-"));
    const store = new RoleStore(dir);
    expect(() => store.create({ name: "aws" })).toThrow();
    expect(() => store.update("nope", {})).toThrow();
    expect(() => store.delete("nope")).toThrow();
  });

  // ROLES-UNIFY §2/§3.2: role.create's dotted-name rejection is an RPC-layer concern
  // (RoleCreateRequestSchema) — the store itself accepts a dotted, team-qualified name
  // via create/upsert (the migration and syncProjectTeam both write these directly).
  it("create/upsert accept a dotted, team-qualified name (the RPC-layer dot rejection lives elsewhere)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-roles-"));
    const store = new RoleStore(dir);
    store.create({ name: "chimera-dev.worker", cwd: "/tmp" });
    expect(store.get("chimera-dev.worker").cwd).toBe("/tmp");
  });

  it("upsert creates a new entry, then overwrites it in place on a later call — never throws DuplicateRoleError", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-roles-"));
    const store = new RoleStore(dir);
    store.upsert({ name: "chimera-dev.worker", cwd: "/tmp/a" });
    store.upsert({ name: "chimera-dev.worker", cwd: "/tmp/b" });
    expect(store.get("chimera-dev.worker").cwd).toBe("/tmp/b");
    expect(store.list().filter((r) => r.name === "chimera-dev.worker")).toHaveLength(1);
  });
});
