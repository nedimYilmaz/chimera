import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { AgentSupervisor } from "@chimera/core/supervisor";

// Final-acceptance MAJOR 3 (in-session conductor marker): the supervisor folds
// spec.conductor onto the agent_started event's data, so a UI following the
// live stream stamps the ◆ marker without waiting for an agent.list refetch.
// Additive contract: a NON-conductor spawn's agent_started stays byte-identical
// (no conductor:false noise).

const STARTED_THEN_DONE: FakeStep[] = [
  { emit: { kind: "agent_started", data: { sessionId: "sess-c" } } },
  { end: { resultText: "done", costUsd: 0 } },
];

function makeSupervisor(scenarios: FakeStep[][]) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-sup-conductor-"));
  const cfg = ChimeraConfigSchema.parse({
    accounts: [{ name: "acct", provider: "claude", auth: { type: "command", run: "irrelevant", injectAs: "ANTHROPIC_API_KEY" } }],
    autoOrder: ["acct"],
  });
  const events = new EventLog(dir);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(cfg),
    credentials: new CredentialResolver(async () => ({ stdout: "tok\n", code: 0 })),
    backends: new Map([["claude", new FakeAgentBackend(scenarios)]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
  });
  return { sup, events };
}

describe("agent_started carries spec.conductor (MAJOR 3)", () => {
  it("a conductor spawn's agent_started data gains conductor:true", async () => {
    const { sup, events } = makeSupervisor([STARTED_THEN_DONE]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "acct", conductor: true });
    await new Promise((r) => setTimeout(r, 20)); // let the fake's fire-and-forget events settle

    const started = events.tail(rec.agentId, 10).find((e) => e.kind === "agent_started");
    expect(started).toBeDefined();
    expect(started?.data["conductor"]).toBe(true);
    expect(started?.data["sessionId"]).toBe("sess-c"); // existing fields untouched
  });

  it("a plain spawn's agent_started data stays without the field (additive)", async () => {
    const { sup, events } = makeSupervisor([STARTED_THEN_DONE]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "acct" });
    await new Promise((r) => setTimeout(r, 20));

    const started = events.tail(rec.agentId, 10).find((e) => e.kind === "agent_started");
    expect(started).toBeDefined();
    expect("conductor" in (started?.data ?? {})).toBe(false);
  });
});

// PROJECT-CONDUCTOR-VISIBILITY: every successful spawn() now appends a leading kind:"status"
// registration marker (data.registered:true) BEFORE any backend event — a resumeOnly conductor
// (e.g. engine.ts's lazy project conductor) pushes no first turn and may never get a real
// agent_started at all, so this is the ONLY signal a live event-stream client (packages/app,
// which fetches agent.list exactly once at bootstrap) ever gets for that row. Deliberately a
// plain status event, not a synthetic agent_started — see health.ts's HealthMonitor for the
// one place that must treat it as the same "no turn opened yet" idle-exemption bucket.
describe("spawn() announces every registered record (PROJECT-CONDUCTOR-VISIBILITY)", () => {
  it("a resumeOnly conductor with NO scripted backend events still gets a registration event carrying conductor/projectId", async () => {
    const { sup, events } = makeSupervisor([[]]);   // empty scenario: the fake backend never emits anything
    const rec = await sup.spawn(
      { prompt: "x", cwd: "/tmp", isolation: "none", account: "acct", conductor: true, resumeOnly: true },
      { projectId: "my-project" },
    );
    const tail = events.tail(rec.agentId, 10);
    expect(tail).toHaveLength(1);
    expect(tail[0]!.kind).toBe("status");
    expect(tail[0]!.data).toEqual({
      state: "running", registered: true, conductor: true, projectId: "my-project",
      treeId: rec.agentId, depth: 0,
      // AGENT-IDENTITY-INVISIBLE-IN-APP: the four identity fields ride this marker too — for an
      // idle project conductor it is the ONLY event that will ever carry them.
      accountName: "acct", provider: "claude", permissionProfile: "acceptEdits", permissionRequest: "auto",
      createdAt: expect.any(Number),
    });
    // no agent_started ever arrives for a resumeOnly conductor with no scripted turn
    expect(tail.some((e) => e.kind === "agent_started")).toBe(false);
  });

  it("a fresh (non-resumeOnly) conductor spawn gets the registration event FIRST, then its real agent_started — no duplicate", async () => {
    const { sup, events } = makeSupervisor([STARTED_THEN_DONE]);
    const rec = await sup.spawn(
      { prompt: "x", cwd: "/tmp", isolation: "none", account: "acct", conductor: true },
      { projectId: "my-project" },
    );
    await new Promise((r) => setTimeout(r, 20));

    const kinds = events.tail(rec.agentId, 10).map((e) => e.kind);
    expect(kinds.filter((k) => k === "agent_started")).toHaveLength(1);   // never duplicated
    expect(kinds[0]).toBe("status");
    expect(kinds[1]).toBe("agent_started");
  });

  it("a plain (non-conductor, projectId-less) spawn's registration event omits conductor/projectId (additive)", async () => {
    const { sup, events } = makeSupervisor([STARTED_THEN_DONE]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "acct" });
    const registration = events.tail(rec.agentId, 10).find((e) => e.kind === "status");
    expect(registration?.data).toEqual({
      state: "running", registered: true, treeId: rec.agentId, depth: 0,
      accountName: "acct", provider: "claude", permissionProfile: "acceptEdits", permissionRequest: "auto",
      createdAt: expect.any(Number),
    });
  });
});

// A leading ~ in cwd is a shell-ism the OS never resolves as a chdir target, so
// the supervisor expands it to the home dir at spawn — otherwise a spec.cwd like
// "~/Documents" fails the spawn (the scheduled-agent "agent failed" the user hit).
describe("spawn expands a leading ~ in cwd", () => {
  it("resolves ~/x to homedir/x on the record spec (every downstream cwd consumer sees it)", async () => {
    const { sup } = makeSupervisor([STARTED_THEN_DONE]);
    const rec = await sup.spawn({ prompt: "x", cwd: "~/Documents", isolation: "none", account: "acct" });
    expect(rec.spec.cwd).toBe(join(homedir(), "Documents"));
  });
  it("resolves a bare ~ to the home dir", async () => {
    const { sup } = makeSupervisor([STARTED_THEN_DONE]);
    const rec = await sup.spawn({ prompt: "x", cwd: "~", isolation: "none", account: "acct" });
    expect(rec.spec.cwd).toBe(homedir());
  });
  it("leaves an absolute cwd untouched", async () => {
    const { sup } = makeSupervisor([STARTED_THEN_DONE]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp/abs", isolation: "none", account: "acct" });
    expect(rec.spec.cwd).toBe("/tmp/abs");
  });
});

// MULTI-LEVEL-NESTING: agent_started also folds the record's lineage (treeId/depth/
// parentId/projectId), so an event-stream-only client (the desktop app fetches
// agent.list exactly once at bootstrap) can nest a post-connect spawn under its real
// parent at any depth -- previously a depth-1 direct spawn (originConductorId null,
// membership none, so nothing above fired) projected lineage-free and rendered as a
// detached top-level row.
describe("agent_started carries record lineage (MULTI-LEVEL-NESTING)", () => {
  it("a child spawn's agent_started data gains treeId/depth/parentId", async () => {
    const { sup, events } = makeSupervisor([STARTED_THEN_DONE]);
    const rec = await sup.spawn(
      { prompt: "x", cwd: "/tmp", isolation: "none", account: "acct" },
      { parentId: "parent-1", treeId: "tree-1", depth: 1 },
    );
    await new Promise((r) => setTimeout(r, 20));

    const started = events.tail(rec.agentId, 10).find((e) => e.kind === "agent_started");
    expect(started).toBeDefined();
    expect(started?.data["treeId"]).toBe("tree-1");
    expect(started?.data["depth"]).toBe(1);
    expect(started?.data["parentId"]).toBe("parent-1");
    expect(started?.data["sessionId"]).toBe("sess-c"); // existing fields untouched
  });

  it("a root spawn's agent_started carries its own-id treeId at depth 0 and OMITS the null parentId", async () => {
    const { sup, events } = makeSupervisor([STARTED_THEN_DONE]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "acct" });
    await new Promise((r) => setTimeout(r, 20));

    const started = events.tail(rec.agentId, 10).find((e) => e.kind === "agent_started");
    expect(started).toBeDefined();
    expect(started?.data["treeId"]).toBe(rec.agentId);
    expect(started?.data["depth"]).toBe(0);
    expect("parentId" in (started?.data ?? {})).toBe(false); // additive: no null-noise
  });
});

// TEAMGROUP-LIVE: the supervisor also folds the scheduler-stamped team/role
// membership onto agent_started (same mechanism as conductor above), so a team
// worker spawned AFTER the app's initial agent.list load groups under its team
// from the live stream instead of rendering teamless/detached until a refetch.
describe("agent_started carries scheduler membership (TEAMGROUP-LIVE)", () => {
  it("a team spawn's agent_started data gains membership {team, role}", async () => {
    const { sup, events } = makeSupervisor([STARTED_THEN_DONE]);
    const rec = await sup.spawn(
      { prompt: "x", cwd: "/tmp", isolation: "none", account: "acct" },
      { membership: { team: "team-chimera", role: "staff-pm-2" } },
    );
    await new Promise((r) => setTimeout(r, 20));

    const started = events.tail(rec.agentId, 10).find((e) => e.kind === "agent_started");
    expect(started).toBeDefined();
    expect(started?.data["membership"]).toEqual({ team: "team-chimera", role: "staff-pm-2" });
    expect(started?.data["sessionId"]).toBe("sess-c"); // existing fields untouched
  });

  it("a plain (teamless) spawn's agent_started omits membership (additive)", async () => {
    const { sup, events } = makeSupervisor([STARTED_THEN_DONE]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", isolation: "none", account: "acct" });
    await new Promise((r) => setTimeout(r, 20));

    const started = events.tail(rec.agentId, 10).find((e) => e.kind === "agent_started");
    expect(started).toBeDefined();
    expect("membership" in (started?.data ?? {})).toBe(false);
  });
});

// AGENT-IDENTITY-INVISIBLE-IN-APP: account/provider/permissionProfile/permissionRequest reached a
// client ONLY through agent.list's snapshot, and packages/app never dispatches one — so the app
// showed no `account:` chip (which IS its click-to-switch affordance) and no `full·auto` permission
// chip, making an agent that WAS in auto mode read as if it had lost it. Both first-sight events now
// stamp all four, read from record.spec so they are the LIVE values setPermission mutates in place.
describe("first-sight events carry account/provider/permission (AGENT-IDENTITY-INVISIBLE-IN-APP)", () => {
  it("agent_started stamps all four, alongside the fields it already carried", async () => {
    const { sup, events } = makeSupervisor([STARTED_THEN_DONE]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", isolation: "none", account: "acct",
      permissionProfile: "full", on: { permissionRequest: "auto" },
    });
    await new Promise((r) => setTimeout(r, 20));

    const started = events.tail(rec.agentId, 10).find((e) => e.kind === "agent_started");
    expect(started?.data).toMatchObject({
      accountName: "acct", provider: "claude", permissionProfile: "full", permissionRequest: "auto",
      sessionId: "sess-c",   // pre-existing fields untouched
    });
  });

  it("reflects a LIVE setPermission, not the spawn-time spec — this is what makes the chip correct after a respawn", async () => {
    const { sup, events } = makeSupervisor([STARTED_THEN_DONE, STARTED_THEN_DONE]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", isolation: "none", account: "acct",
      conductor: true, resumeOnly: true, permissionProfile: "readOnly", on: { permissionRequest: "tui" },
    });
    await sup.setPermission(rec.agentId, { permissionProfile: "full", permissionRequest: "auto" });

    // A respawn (what agent.setAccount does) re-announces the record; the marker must carry the
    // LIVE values, or the operator's auto mode looks lost every time they switch accounts.
    const respawned = await sup.spawn(
      { ...rec.spec, resume: null, resumeOnly: true },
      { agentId: rec.agentId, treeId: rec.treeId, depth: rec.depth },
    );
    const markers = events.tail(respawned.agentId, 20).filter((e) => e.kind === "status" && e.data["registered"] === true);
    expect(markers.at(-1)?.data).toMatchObject({ permissionProfile: "full", permissionRequest: "auto" });
  });
});
