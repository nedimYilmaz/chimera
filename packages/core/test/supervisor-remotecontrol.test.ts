import { voiceAgentName } from "@chimera/protocol/agent-name";
import { describe, it, expect, vi } from "vitest";
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
import { reconstructAgentsFromLog } from "@chimera/core/replay";
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
    expect(status.name).toBe(voiceAgentName(rec.agentId));
    expect(status.sessionUrl).toContain(status.name);
    expect(fake.spawns).toHaveLength(1);   // NO respawn — same query, unlike setModel
  });

  it("uses the agent name, follows later renames, and preserves explicit remote names", async () => {
    const { sup, events } = makeSupervisor([RUNNING]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", displayLabel: "daily-digest" });
    expect((await sup.remoteControl(rec.agentId, true)).name).toBe("daily-digest");
    await sup.parkIdle(rec.agentId, 99_999_999);
    expect(rec.state).toBe("running");
    await sup.renameAgent(rec.agentId, "renamed", { byOperator: true });
    await sup.maintainRemoteControl(rec.agentId);
    const lastRemote = () => events.tail(rec.agentId, 100).filter(e => e.data.remoteControl).at(-1)!.data.remoteControl;
    expect(lastRemote()).toMatchObject({ enabled: true, name: "renamed" });
    await sup.remoteControl(rec.agentId, true, "custom");
    await sup.maintainRemoteControl(rec.agentId);
    expect(lastRemote()).toMatchObject({ name: "custom" });
    const replayed = structuredClone(rec); delete replayed.remoteControlIntent;
    reconstructAgentsFromLog([replayed], events.tail(rec.agentId, 100));
    expect(replayed.remoteControlIntent).toEqual({ enabled: true, name: "custom" });
    await sup.remoteControl(rec.agentId, false);
    reconstructAgentsFromLog([replayed], events.tail(rec.agentId, 100));
    expect(replayed.remoteControlIntent).toBeUndefined();
    await sup.maintainRemoteControl(rec.agentId);
    expect(lastRemote()).toMatchObject({ enabled: false });
    await sup.parkIdle(rec.agentId, 99_999_999);
    expect(rec.state).toBe("paused");
  });

  it("serializes a slow renewal before off and does not renew after operator pause", async () => {
    const { sup } = makeSupervisor([RUNNING]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await sup.remoteControl(rec.agentId, true);
    const handle = (sup as any).handles.get(rec.agentId);
    let finish!: () => void;
    const calls: boolean[] = [];
    handle.remoteControl = vi.fn(async (enabled: boolean) => {
      calls.push(enabled);
      if (enabled) await new Promise<void>(resolve => { finish = resolve; });
    });
    const renewal = sup.maintainRemoteControl(rec.agentId);
    await vi.waitFor(() => expect(calls).toEqual([true]));
    const off = sup.remoteControl(rec.agentId, false);
    (sup as any).reissueRemoteControlIntent(rec.agentId);
    const late = sup.maintainRemoteControl(rec.agentId);
    finish(); await Promise.all([renewal, off, late]);
    expect(calls).toEqual([true, false]);
    expect(rec.remoteControlIntent).toBeUndefined();
    rec.remoteControlIntent = { enabled: true };
    await sup.hold(rec.agentId);
    await sup.maintainRemoteControl(rec.agentId);
    expect(rec.state).toBe("paused");
    expect(calls).toEqual([true, false]);
  });

  it("restores only automatic idle/restart pauses and reports renewal failures without exposing provider text", async () => {
    const { sup, events } = makeSupervisor([RUNNING, RUNNING]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    await vi.waitFor(() => expect(rec.sessionId).toBe("sess-1"));
    await sup.remoteControl(rec.agentId, true);
    await sup.hold(rec.agentId);
    // Model a legacy idle pause / restored daemon snapshot, not a fresh operator request.
    rec.pauseReason = "daemon-restart";
    await sup.maintainRemoteControl(rec.agentId);
    await vi.waitFor(() => expect(rec.state).toBe("running"));
    await vi.waitFor(() => expect(events.tail(rec.agentId, 100).filter(e => e.data.remoteControl)).toHaveLength(2));
    (sup as any).handles.get(rec.agentId).remoteControl = async () => { throw new Error("secret-provider-token"); };
    await sup.maintainRemoteControl(rec.agentId);
    expect(rec.state).toBe("running"); expect(rec.remoteControlIntent?.enabled).toBe(true);
    const check = events.tail(rec.agentId, 100).filter(e => e.data.remoteControlCheck).at(-1)!;
    expect(check.data.remoteControlCheck).toEqual({ ok: false, reason: "provider-check-failed" });
    expect(JSON.stringify(check)).not.toContain("secret-provider-token");
    await sup.kill(rec.agentId);
  });

  it("does not commit a stale remote acknowledgment after the session is killed", async () => {
    const { sup } = makeSupervisor([RUNNING]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none" });
    const handle = (sup as any).handles.get(rec.agentId);
    let finish!: () => void;
    handle.remoteControl = () => new Promise<void>(resolve => { finish = resolve; });
    const pending = sup.remoteControl(rec.agentId, true);
    const rejected = expect(pending).rejects.toThrow("session changed");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await sup.kill(rec.agentId); finish(); await rejected;
    expect(rec.remoteControlIntent).toBeUndefined();
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

    await sup.hold(rec.agentId);
    await expect(sup.resumePaused(rec.agentId)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));   // let the fire-and-forget reissue attempt (and swallow) settle

    expect(sup.status(rec.agentId).state).toBe("running");
    const rcEvents = events.tail(rec.agentId, 100).filter((e) => e.kind === "status" && e.data["remoteControl"] !== undefined);
    expect(rcEvents).toHaveLength(0);   // no control surface -> never even attempts to emit a status event
  });
});
