import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { UnknownAgentError, AgentNotRunningError, RemoteControlUnsupportedError, RemoteControlDeniedError } from "@chimera/core/supervisor";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSupervisor, CFG, fakeExec } from "./helpers.js";

// REMOTE-CONTROL: AgentSupervisor.remoteControl — a LIVE control-request round trip
// (no kill/respawn, unlike setModel) via the backend handle's optional remoteControl().
const RUNNING: FakeStep[] = [
  { emit: { kind: "agent_started", data: { sessionId: "sess-1" } } },
  { awaitSend: true },
];

function makeUnsupportedSupervisor(scenarios: FakeStep[][]) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-sup-rc-"));
  const fake = new FakeAgentBackend(scenarios, "claude", false);   // remoteControlSupported: false
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    permissionTimeoutMs: 100,
    questionTimeoutMs: 100,
  });
  return { sup, fake, events };
}

describe("AgentSupervisor.remoteControl", () => {
  it("enables live (no respawn) and returns the attach URL", async () => {
    const { sup, fake } = makeSupervisor([RUNNING]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await new Promise((r) => setTimeout(r, 20));

    const status = await sup.remoteControl(rec.agentId, true);

    expect(status.enabled).toBe(true);
    expect(status.provider).toBe("claude");
    expect(status.name).toBe(`chimera-${rec.agentId.slice(0, 8)}`);
    expect(status.sessionUrl).toContain(status.name);
    expect(fake.spawns).toHaveLength(1);   // NO respawn — same query, unlike setModel
  });

  it("honors an explicit name override", async () => {
    const { sup } = makeSupervisor([RUNNING]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await new Promise((r) => setTimeout(r, 20));

    const status = await sup.remoteControl(rec.agentId, true, "my-custom-name");

    expect(status.name).toBe("my-custom-name");
  });

  it("disables and returns enabled:false with no name/url", async () => {
    const { sup } = makeSupervisor([RUNNING]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await new Promise((r) => setTimeout(r, 20));
    await sup.remoteControl(rec.agentId, true);

    const status = await sup.remoteControl(rec.agentId, false);

    expect(status.enabled).toBe(false);
    expect(status.name).toBeUndefined();
    expect(status.sessionUrl).toBeUndefined();
  });

  it("appends a status event carrying the remoteControl payload", async () => {
    const { sup, events } = makeSupervisor([RUNNING]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await new Promise((r) => setTimeout(r, 20));

    await sup.remoteControl(rec.agentId, true);

    const tail = events.tail(rec.agentId, 50);
    const ev = tail.find((e) => e.kind === "status" && e.data["remoteControl"] !== undefined);
    expect(ev).toBeDefined();
    expect((ev!.data["remoteControl"] as { enabled: boolean }).enabled).toBe(true);
  });

  it("throws UnknownAgentError for a ghost/unknown agentId", async () => {
    const { sup } = makeSupervisor([]);
    await expect(sup.remoteControl("ghost-id", true)).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("throws AgentNotRunningError for a non-running agent", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await new Promise((r) => setTimeout(r, 30));   // let it settle to "done"

    await expect(sup.remoteControl(rec.agentId, true)).rejects.toBeInstanceOf(AgentNotRunningError);
  });

  it("throws RemoteControlUnsupportedError for a provider whose handle has no remoteControl()", async () => {
    const { sup } = makeUnsupportedSupervisor([RUNNING]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await new Promise((r) => setTimeout(r, 20));

    await expect(sup.remoteControl(rec.agentId, true)).rejects.toBeInstanceOf(RemoteControlUnsupportedError);
    await expect(sup.remoteControl(rec.agentId, true)).rejects.toMatchObject({ code: "protocol" });
  });

  // REMOTE-CONTROL-CAPABILITY: the provider refuses enableRemoteControl for a non-
  // subscription-authed credential server-side ("disabled by your organization's
  // policy"). Simulated via FakeAgentBackend's rejection seam — no real sk-ant-oat01
  // credential involved. The wrapped error must name the offending account/credential
  // type and point at which configured account WOULD work, without swallowing the
  // provider's original message.
  it("wraps a provider policy denial with account, credential type, and capable accounts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-sup-rc-deny-"));
    const fake = new FakeAgentBackend([RUNNING], "claude", true, "disabled by your organization's policy");
    const sup = new AgentSupervisor({
      registry: new AccountRegistry(CFG),
      credentials: new CredentialResolver(fakeExec),
      backends: new Map([["claude", fake]]),
      events: new EventLog(dir),
      mailboxes: new MailboxStore(dir),
      cooldowns: new CooldownTracker(60_000),
      permissionTimeoutMs: 100,
      questionTimeoutMs: 100,
    });
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "second" });
    await new Promise((r) => setTimeout(r, 20));

    const err = await sup.remoteControl(rec.agentId, true).catch((e) => e);

    expect(err).toBeInstanceOf(RemoteControlDeniedError);
    expect(err.message).toContain('"second"');
    expect(err.message).toContain("keychain");
    expect(err.message).toContain("main");   // the subscription-authed account IS capable
    expect(err.message).toContain("disabled by your organization's policy");   // original message preserved
  });
});

// REMOTE-CONTROL-SURVIVES-PAUSE: a provider with no live control surface (codex today) must
// never have reissueRemoteControlIntent throw on every single resume — it is a fire-and-forget
// best-effort reissue, not a hard requirement of the resume succeeding.
describe("AgentSupervisor.resumePaused — remote control on a provider with no control surface", () => {
  it("resumes cleanly and stays a no-op even with a stored enabled intent", async () => {
    const { sup, events } = makeUnsupportedSupervisor([RUNNING, RUNNING]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await new Promise((r) => setTimeout(r, 20));

    // remoteControl() itself would throw RemoteControlUnsupportedError on this backend, so an
    // intent could only ever get here via a record stamped before a provider migration/downgrade —
    // stamp it directly to prove reissue on resume degrades gracefully rather than assuming it.
    const agents = (sup as unknown as { agents: Map<string, { remoteControlIntent?: { enabled: true; name?: string } }> }).agents;
    agents.get(rec.agentId)!.remoteControlIntent = { enabled: true };

    await sup.parkIdle(rec.agentId, 99_999);
    await expect(sup.resumePaused(rec.agentId)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));   // let the fire-and-forget reissue attempt (and swallow) settle

    expect(sup.status(rec.agentId).state).toBe("running");
    const rcEvents = events.tail(rec.agentId, 100).filter((e) => e.kind === "status" && e.data["remoteControl"] !== undefined);
    expect(rcEvents).toHaveLength(0);   // no control surface -> never even attempts to emit a status event
  });
});
