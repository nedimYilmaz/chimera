import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/events.js";
import { RoleStore } from "../src/roles-store.js";
import { TeamManager } from "../src/teams.js";
import { RoleRpc } from "../src/rpc/role-rpc.js";

function makeRoleRpc() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-role-rpc-"));
  const roles = new RoleStore(dir);
  const teams = new TeamManager(dir, new EventLog(dir));
  return { rpc: new RoleRpc({ roles, teams }), roles, teams };
}

describe("RoleRpc", () => {
  it("role.create/list/update/delete round-trip", async () => {
    const { rpc } = makeRoleRpc();
    const created = await rpc.handlers["role.create"]({ spec: { name: "oncall", instructions: "x" } });
    expect(created).toMatchObject({ name: "oncall", instructions: "x" });

    const listed = await rpc.handlers["role.list"]({});
    expect(listed.map((r) => r.name)).toContain("oncall");

    const updated = await rpc.handlers["role.update"]({ name: "oncall", patch: { instructions: "y" } });
    expect(updated.instructions).toBe("y");

    const deleted = await rpc.handlers["role.delete"]({ name: "oncall" });
    expect(deleted).toEqual({ ok: true });
    expect((await rpc.handlers["role.list"]({})).map((r) => r.name)).not.toContain("oncall");
  });

  it("lists the 4 seeded builtins on a fresh store", async () => {
    const { rpc } = makeRoleRpc();
    const listed = await rpc.handlers["role.list"]({});
    expect(listed.map((r) => r.name).sort()).toEqual(["aws", "blank", "review", "triage"]);
  });

  // ROLES-UNIFY §5/§9.4: role.update no longer fans out a materialized copy anywhere — a
  // team binding resolves the library live, so editing the library role is visible at
  // every binding without this RPC ever touching TeamManager.
  it("role.update never touches a team that binds to it (nothing to propagate)", async () => {
    const { rpc, teams } = makeRoleRpc();
    await rpc.handlers["role.create"]({ spec: { name: "oncall", cwd: "/tmp", instructions: "x" } });
    teams.create({ name: "crew", roles: { dev: { role: "oncall", overrides: {} } } });
    const before = teams.get("crew");

    await rpc.handlers["role.update"]({ name: "oncall", patch: { instructions: "y" } });

    expect(teams.get("crew")).toEqual(before); // the binding row itself is untouched
  });

  // ROLES-UNIFY §5: role.delete's "still attached" check is now a live scan of every
  // team's bindings (binding.role === name), not the old sharedRoles marker list.
  it("role.delete refuses while a team binding still references it, listing the team", async () => {
    const { rpc, teams } = makeRoleRpc();
    await rpc.handlers["role.create"]({ spec: { name: "oncall", cwd: "/tmp" } });
    teams.create({ name: "crew", roles: { dev: { role: "oncall", overrides: {} } } });

    // role.delete is a synchronous handler — it throws directly rather than returning a
    // rejected promise, so the call must be wrapped in a thunk for toThrow to catch it.
    expect(() => rpc.handlers["role.delete"]({ name: "oncall" })).toThrow(/crew/);
  });
});
