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
import { Engine } from "@chimera/core/engine";
import type { AgentBackend } from "@chimera/core/backend";
import { CFG, fakeExec, makeEngineHome } from "./helpers.js";

// LEAN-AGENT-CONTEXT (token economy): a fresh NON-conductor claude spawn is given
// strictMcpConfig so the SDK mounts ONLY chimera's injected MCP server, dropping the
// machine's foreign MCP catalog (hundreds of tool defs) from every spawn. This is the
// deterministic "real-spawn smoke" for that injection — the FakeAgentBackend captures the
// exact ResolvedAgentSpec the real backend would forward to the SDK.
function makeLeanSupervisor(leanAgentContext?: () => boolean, leanAgentSkills?: () => readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-sup-lean-"));
  const fake = new FakeAgentBackend([]);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    ...(leanAgentSkills ? { leanAgentSkills } : {}),
    permissionTimeoutMs: 100,
    ...(leanAgentContext ? { leanAgentContext } : {}),
  });
  return { sup, fake };
}

describe("AgentSupervisor: LEAN-AGENT-CONTEXT strictMcpConfig injection", () => {
  it("sets strictMcpConfig on a non-conductor claude spawn when lean is ON", async () => {
    const { sup, fake } = makeLeanSupervisor(() => true);
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    expect(fake.spawns[0]!.providerOptions["strictMcpConfig"]).toBe(true);
  });

  it("sets strictMcpConfig for a CONDUCTOR too — the exemption was the fleet's costliest line", async () => {
    // Conductors were exempt on the theory that orchestration needs the servers to hand. Measured
    // against the event log, they are 43% of all spend and carry 25 MCP servers each, and every
    // one of those tool definitions was re-read on every one of their calls. mcp_store_tools
    // reaches all of them on demand, which is the same bargain every worker already takes.
    const { sup, fake } = makeLeanSupervisor(() => true);
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none", conductor: true });
    expect(fake.spawns[0]!.providerOptions["strictMcpConfig"]).toBe(true);
  });

  it("passes the operator's skill ALLOWLIST, not an off switch", async () => {
    // The distinction that matters: the SDK rejects an unlisted skill at the Skill tool rather than
    // deferring it. So unlike a foreign MCP tool (reachable via mcp_store_tools) or a chimera tool
    // (chimera_tools), an unlisted skill is refused — an empty list removes a capability instead of
    // making it lazy. Measured: 348 skills loaded into every prompt, 5 ever used.
    const { sup, fake } = makeLeanSupervisor(() => true, () => ["superpowers:brainstorming"]);
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    expect(fake.spawns[0]!.skills).toEqual(["superpowers:brainstorming"]);
  });

  it("gives a lean spawn NO skills when the operator named none", async () => {
    // The SDK's own doc: "omitted (default): no SDK auto-configuration. The CLI's own defaults
    // still apply, so this is not 'skills off'." chimera never passed it, and the measurement
    // showed the consequence — agents spawning with settingSources:[] still carried ~348 skill
    // descriptions in a prefix that is re-read on every call.
    const { sup, fake } = makeLeanSupervisor(() => true);
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    expect(fake.spawns[0]!.skills).toEqual([]);
  });

  it("never overrides a spec that named its own skills", async () => {
    // A role that genuinely needs one lists it, and lean must not take it away.
    const { sup, fake } = makeLeanSupervisor(() => true);
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none", skills: ["brainstorming"] } as never);
    expect(fake.spawns[0]!.skills).toEqual(["brainstorming"]);
  });

  it("leaves skills alone when lean is off", async () => {
    const { sup, fake } = makeLeanSupervisor(() => false);
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    expect(fake.spawns[0]!.skills).toBeUndefined();
  });

  it("byte-identical when the lean seam is absent (every pre-feature deployment)", async () => {
    const { sup, fake } = makeLeanSupervisor();
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    expect(fake.spawns[0]!.providerOptions["strictMcpConfig"]).toBeUndefined();
  });

  it("respects the escape hatch: lean OFF ⇒ no strictMcpConfig", async () => {
    const { sup, fake } = makeLeanSupervisor(() => false);
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    expect(fake.spawns[0]!.providerOptions["strictMcpConfig"]).toBeUndefined();
  });

  it("never overrides a spec that set strictMcpConfig itself (false stays false)", async () => {
    const { sup, fake } = makeLeanSupervisor(() => true);
    await sup.spawn({
      prompt: "hi", cwd: "/tmp", isolation: "none",
      providerOptions: { strictMcpConfig: false },
    });
    expect(fake.spawns[0]!.providerOptions["strictMcpConfig"]).toBe(false);
  });

  it("read fresh per launch (not snapshotted at construction)", async () => {
    let on = false;
    const { sup, fake } = makeLeanSupervisor(() => on);
    // Distinct accounts keep this deterministic regardless of how fast the first agent settles.
    await sup.spawn({ prompt: "a", cwd: "/tmp", isolation: "none", account: "main" });
    expect(fake.spawns[0]!.providerOptions["strictMcpConfig"]).toBeUndefined();
    on = true;
    await sup.spawn({ prompt: "b", cwd: "/tmp", isolation: "none", account: "second" });
    expect(fake.spawns[1]!.providerOptions["strictMcpConfig"]).toBe(true);
  });

  it("end-to-end on an Engine: leanAgentContext defaults ON, so a fresh spawn is lean", async () => {
    const fake = new FakeAgentBackend([]);
    const e = new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", fake]]) });
    await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } });
    expect(fake.spawns[0]!.providerOptions["strictMcpConfig"]).toBe(true);
  });

  // LEAN-AGENT-MCPS: the first-class `strictMcpConfig` spec field is the SAME opt-out signal as
  // the older `providerOptions.strictMcpConfig` escape hatch — either one being SET (true or
  // false) must stop this daemon-wide default from clobbering it via the providerOptions
  // injection path. The field itself reaches the backend as a plain passthrough (ResolvedAgentSpec
  // = AgentSpec & {...}), asserted directly here rather than via providerOptions.
  it("a spec that sets the first-class strictMcpConfig field is never overridden by the daemon default", async () => {
    const { sup, fake } = makeLeanSupervisor(() => true);
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none", strictMcpConfig: false });
    expect(fake.spawns[0]!.strictMcpConfig).toBe(false);
    // The daemon-default injection path (providerOptions) must stay untouched — claude.ts reads
    // spec.strictMcpConfig directly, so a redundant providerOptions.strictMcpConfig:true here
    // would silently flip the effective SDK value back to true (see claude.ts's spread order).
    expect(fake.spawns[0]!.providerOptions["strictMcpConfig"]).toBeUndefined();
  });

  it("the first-class strictMcpConfig field works even when the daemon default is OFF", async () => {
    const { sup, fake } = makeLeanSupervisor(() => false);
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none", strictMcpConfig: true });
    expect(fake.spawns[0]!.strictMcpConfig).toBe(true);
  });
});
