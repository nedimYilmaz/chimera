import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor, UnknownAgentError, InvalidPermissionError } from "@chimera/core/supervisor";
import type { MailboxMessage } from "@chimera/core/mailbox";
import { makeSupervisor, makeMultiProviderSupervisor, fakeExec } from "./helpers.js";

// KIMI-BACKEND S3 / S0(d1): a standalone "kimi" account supervisor, local to this file (rather
// than widening the shared makeMultiProviderSupervisor helper other suites also call) — proves
// setPermission's appliedToRunningProcess:false path for kimi the same way the codex test below
// proves it for codex.
function makeKimiSupervisor(kimiScenarios: FakeStep[][]) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-ksup-"));
  const kimi = new FakeAgentBackend(kimiScenarios, "kimi");
  const cfg = ChimeraConfigSchema.parse({
    accounts: [{ name: "km-main", provider: "kimi", auth: { type: "subscription" } }],
    autoOrder: ["km-main"],
    caps: { maxAgentsTotal: 2, perAccount: {} },
  });
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(cfg),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["kimi", kimi]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    permissionTimeoutMs: 100,
  });
  return { sup, dir };
}

// setPermission's mailbox notice is delivered (drained) synchronously to the fake
// handle for a running agent, same as any other agent_send — so by the time
// setPermission() returns, MailboxStore.pending() no longer shows it (it's been
// acked). Read the raw per-agent JSONL directly to see every message ever enqueued,
// drained or not, exactly the way this notice must actually reach the agent.
function readAllMailboxMessages(dir: string, agentId: string): MailboxMessage[] {
  const path = join(dir, "mailboxes", encodeURIComponent(agentId) + ".jsonl");
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as MailboxMessage);
  } catch {
    return [];
  }
}

// TUI backlog 8b: dynamic (live, no-restart) permission change for a RUNNING agent.
// decidePermission() reads record.spec FRESH on every canUseTool call, so mutating
// record.spec.on.permissionRequest / record.spec.permissionProfile takes effect on
// the agent's VERY NEXT permission decision.

describe("AgentSupervisor.setPermission", () => {
  it("a live change takes effect on the agent's next decision — no new permission_request, mid-run, no restart", async () => {
    // two Bash asks: policy starts as "tui" (routes to permission_request + external
    // answer). On the FIRST permission_request we flip the live spec to auto/full.
    // If the mutation "took", the SECOND ask must be decided synchronously via the
    // "auto" fast path (autoDecision) WITHOUT emitting a second permission_request.
    const scenario: FakeStep[] = [
      { askPermission: { toolName: "Bash" } },
      { askPermission: { toolName: "Bash" } },
      { end: { resultText: "done" } },
    ];
    const { sup, events } = makeSupervisor([scenario]);

    let permissionRequests = 0;
    events.subscribe((e) => {
      if (e.kind !== "permission_request") return;
      permissionRequests++;
      if (permissionRequests === 1) {
        sup.setPermission(rec.agentId, { permissionRequest: "auto", permissionProfile: "full" });
      }
      // always answer so a reverted mutation (still routing to tui) doesn't hang the test
      sup.respondPermission(String(e.data["requestId"]), true);
    });

    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none",
      permissionProfile: "acceptEdits", on: { permissionRequest: "tui" },
    });
    await sup.waitFor(rec.agentId, 1000);

    const tail = events.tail(rec.agentId, 50);
    // mutation guard: if setPermission's mutation were a no-op, the second Bash ask
    // would still route through "tui" and emit a SECOND permission_request — this
    // assertion goes from 1 to 2 and fails under that mutation.
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(1);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(2);   // both Bash calls allowed
    expect(tail.some((e) => e.kind === "status" && e.data["denied"] === true)).toBe(false);

    // observability: the live change is visible on the stream
    const changed = tail.find((e) => e.kind === "status" && e.data["permissionChanged"] === true);
    expect(changed?.data).toMatchObject({ permissionChanged: true, permissionRequest: "auto", permissionProfile: "full" });

    // and the record itself reflects the new live spec
    const status = sup.status(rec.agentId);
    expect(status.spec.on.permissionRequest).toBe("auto");
    expect(status.spec.permissionProfile).toBe("full");
  });

  it("a partial patch (permissionRequest only) leaves permissionProfile untouched", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none", permissionProfile: "readOnly",
    });
    sup.setPermission(rec.agentId, { permissionRequest: "poke:caller" });
    const status = sup.status(rec.agentId);
    expect(status.spec.on.permissionRequest).toBe("poke:caller");
    expect(status.spec.permissionProfile).toBe("readOnly");   // untouched
  });

  it("throws UnknownAgentError for a ghost/unknown agentId", () => {
    const { sup } = makeSupervisor([]);
    expect(() => sup.setPermission("ghost-id", { permissionRequest: "auto" })).toThrow(UnknownAgentError);
  });

  it("throws InvalidPermissionError for an invalid permissionRequest value", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    expect(() => sup.setPermission(rec.agentId, { permissionRequest: "bogus" as never })).toThrow(InvalidPermissionError);
  });

  it("throws InvalidPermissionError for an invalid permissionProfile value", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ prompt: "x", cwd: "/tmp", account: "main", isolation: "none" });
    expect(() => sup.setPermission(rec.agentId, { permissionProfile: "bogus" as never })).toThrow(InvalidPermissionError);
  });

  // LIVE-PERMISSION-CHANGE-NOT-TOLD-TO-AGENT: a live setPermission mutation was previously
  // invisible to the agent itself (only the TUI/status stream saw it) — it should now enqueue
  // exactly one mailbox notice naming the new profile, delivered the same way agent_send is.
  it("a real profile change enqueues exactly one mailbox notice naming the new profile", async () => {
    const { sup, dir } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none", permissionProfile: "readOnly",
    });
    sup.setPermission(rec.agentId, { permissionProfile: "acceptEdits" });

    const msgs = readAllMailboxMessages(dir, rec.agentId).filter((m) => m.kind === "user_message");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toContain("acceptEdits");
  });

  it("an unchanged value enqueues no mailbox notice", async () => {
    const { sup, dir } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none", permissionProfile: "readOnly",
    });
    sup.setPermission(rec.agentId, { permissionProfile: "readOnly" });   // same as spawn-time value

    expect(readAllMailboxMessages(dir, rec.agentId).filter((m) => m.kind === "user_message")).toHaveLength(0);
  });

  // CODEX-SETPERMISSION-IS-COSMETIC-TO-THE-OPERATOR: the operator-facing return value must say
  // plainly when a live profile change did NOT reach the running process — codex has no live
  // permission hook and its sandbox is fixed at spawn (supervisor.ts setPermission comment).
  it("returns appliedToRunningProcess:false for a codex agent — the live sandbox is not re-applied", async () => {
    const { sup } = makeMultiProviderSupervisor([], [[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "cx-main", isolation: "none", permissionProfile: "readOnly",
    });
    const result = sup.setPermission(rec.agentId, { permissionProfile: "acceptEdits" });
    expect(result).toEqual({ appliedToRunningProcess: false });
  });

  it("returns appliedToRunningProcess:true for a claude agent — the live spec change genuinely applies", async () => {
    const { sup } = makeSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "main", isolation: "none", permissionProfile: "readOnly",
    });
    const result = sup.setPermission(rec.agentId, { permissionProfile: "acceptEdits" });
    expect(result).toEqual({ appliedToRunningProcess: true });
  });

  // KIMI-BACKEND S3 / S0(d1) CONFIRMED (docs/superpowers/specs/2026-07-28-kimi-backend-s0-findings.md):
  // Kimi's yoloMode is diffed by the SDK only at the START of the next turn (kill+respawn), never
  // pushed live into an already-running CLI process — same operator-facing cosmetic shape as codex.
  it("returns appliedToRunningProcess:false for a kimi agent — yoloMode is a next-turn-only respawn, not a live update", async () => {
    const { sup } = makeKimiSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "km-main", isolation: "none", permissionProfile: "readOnly",
    });
    const result = sup.setPermission(rec.agentId, { permissionProfile: "acceptEdits" });
    expect(result).toEqual({ appliedToRunningProcess: false });
  });

  it("a kimi profile change's mailbox notice names the next-turn-only caveat, not codex's fixed-sandbox one", async () => {
    const { sup, dir } = makeKimiSupervisor([[{ end: { resultText: "done" } }]]);
    const rec = await sup.spawn({
      prompt: "x", cwd: "/tmp", account: "km-main", isolation: "none", permissionProfile: "readOnly",
    });
    sup.setPermission(rec.agentId, { permissionProfile: "acceptEdits" });
    const msgs = readAllMailboxMessages(dir, rec.agentId).filter((m) => m.kind === "user_message");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.text).toContain("start of your NEXT turn");
    expect(msgs[0]?.text).not.toContain("codex note");
  });
});
