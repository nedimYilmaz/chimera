import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import type { AgentBackend } from "@chimera/core/backend";
import { CFG, fakeExec } from "./helpers.js";

// REGISTRATION-EVENT-MISSING-LINEAGE: the registration `status { registered: true }` event is
// the app's FIRST sight of a freshly-spawned agent (agent_started may arrive many events later,
// or never for a resumeOnly spawn) — it must carry the same lineage agent_started does, or a
// queue-spawned worker renders under the wrong (or no) conductor until agent_started finally
// lands. See PROJECT-CONDUCTOR-VISIBILITY comment in supervisor.ts's spawn().

function makeSup() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-reglineage-"));
  return {
    dir,
    sup: new AgentSupervisor({
      registry: new AccountRegistry(CFG),
      credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", new FakeAgentBackend([]) as AgentBackend]]),
      events: new EventLog(dir),
      mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000),
    }),
  };
}

const spec = (cwd = "/tmp/proj") => ({ prompt: "job", cwd, isolation: "none" as const });

describe("AgentSupervisor.spawn: registration status event carries lineage", () => {
  it("a queue-spawned worker's registration event carries originConductorId/parentId/treeId/depth", async () => {
    const { sup, dir } = makeSup();
    const rec = await sup.spawn(spec(), { parentId: "spawner-1", originConductorId: "conductor-1" });

    const log = new EventLog(dir);
    const events = log.replay({ agentId: rec.agentId, limit: 1000 });
    const registration = events.find((e) => e.kind === "status" && e.data["registered"] === true);
    expect(registration).toBeDefined();
    expect(registration!.data["originConductorId"]).toBe("conductor-1");
    expect(registration!.data["parentId"]).toBe("spawner-1");
    expect(registration!.data["treeId"]).toBe(rec.treeId);
    expect(registration!.data["depth"]).toBe(rec.depth);
  });

  it("omits originConductorId/parentId (byte-identical to before) when the record genuinely has none, but still carries treeId/depth", async () => {
    const { sup, dir } = makeSup();
    const rec = await sup.spawn(spec());

    const log = new EventLog(dir);
    const events = log.replay({ agentId: rec.agentId, limit: 1000 });
    const registration = events.find((e) => e.kind === "status" && e.data["registered"] === true);
    expect(registration).toBeDefined();
    expect("originConductorId" in registration!.data).toBe(false);
    expect("parentId" in registration!.data).toBe(false);
    expect(registration!.data["treeId"]).toBe(rec.treeId);
    expect(registration!.data["depth"]).toBe(rec.depth);
  });
});
