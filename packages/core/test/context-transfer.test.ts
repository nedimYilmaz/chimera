import { mkdtempSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { makeMultiProviderSupervisor } from "./helpers.js";
import type { FakeStep } from "@chimera/core/backends/fake";
import type { EventSink } from "@chimera/core/backend";

const running: FakeStep[] = [{ emit: { kind: "agent_started", data: { sessionId: "source-session" } } }, { awaitSend: true }];
const parked: FakeStep[] = [{ awaitSend: true }];
const base = { prompt: "Implement the feature. Do not rebuild.", cwd: "/tmp", isolation: "none" as const, account: "cl-main" };

describe("manual provider context transfer", () => {
  it("preserves identity, constraints, retained history, metadata and cost without a task-result event from compaction", async () => {
    const { sup, claude, codex, events } = makeMultiProviderSupervisor([running, [{ end: { resultText: "Decision: preserve user edits. Next: regression tests.", costUsd: 0.12 } }]], [parked]);
    const r = await sup.spawn({ ...base, instructions: "Never delete other people's changes.", providerOptions: { model: "opus", effort: "max" } });
    await vi.waitFor(() => expect(r.sessionId).toBe("source-session"));
    r.displayLabel = "worker"; r.groups = ["feature"]; r.costUsd = 0.5;
    events.append({ agentId: r.agentId, kind: "message_complete", data: { text: "Changed src/important.ts" } });
    const next = await sup.setAccount(r.agentId, "cx-main", "gpt-6-astra");
    expect(next).toMatchObject({ agentId: r.agentId, treeId: r.treeId, displayLabel: "worker", groups: ["feature"], costUsd: 0.62 });
    expect(claude.spawns[1]).toMatchObject({ resume: "source-session", permissionProfile: "readOnly", maxTurns: 1, orchestration: { allow: false }, mcpServers: {}, plugins: [] });
    expect(codex.spawns[0]).toMatchObject({ resume: null, resumeOnly: false, model: "gpt-6-astra", providerOptions: {} });
    expect(codex.spawns[0]?.prompt).toContain("Decision: preserve user edits");
    expect(codex.spawns[0]?.instructions).toContain("Never delete");
    const tail = events.tail(r.agentId, 100);
    expect(tail.some((e) => e.kind === "result")).toBe(false);
    expect(tail.some((e) => e.kind === "status" && e.data.state === "killed")).toBe(false);
    const transfer = tail.find((e) => e.data.providerSwitch === "completed")?.data.contextTransfer as { mode: string; archive: string };
    expect(transfer.mode).toBe("source-compaction");
    expect(readFileSync(transfer.archive, "utf8")).toContain("Changed src/important.ts");
    expect(statSync(transfer.archive).mode & 0o777).toBe(0o600);
    await sup.kill(next.agentId);
  });

  it("falls back explicitly when the source cannot compact", async () => {
    const { sup, codex, events } = makeMultiProviderSupervisor([running, [{ fail: { message: "source quota exhausted" } }]], [parked]);
    const r = await sup.spawn(base);
    await vi.waitFor(() => expect(r.sessionId).toBe("source-session"));
    events.append({ agentId: r.agentId, kind: "message_complete", data: { text: "Remember the unfinished validation." } });
    await sup.setAccount(r.agentId, "cx-main", "gpt-6-astra");
    expect(codex.spawns[0]?.prompt).toContain("Fallback recorded context");
    expect(codex.spawns[0]?.prompt).toContain("source quota exhausted");
    expect(codex.spawns[0]?.prompt).toContain("unfinished validation");
    await sup.kill(r.agentId);
  });

  it("does not interrupt full-access Claude before explicit Codex risk acknowledgement", async () => {
    const { sup, claude, codex } = makeMultiProviderSupervisor([running], [parked]);
    const r = await sup.spawn({ ...base, permissionProfile: "full" });
    await expect(sup.setAccount(r.agentId, "cx-main", "gpt-6-astra")).rejects.toThrow("acknowledgeCodexFullAccessRisk");
    expect(r.state).toBe("running"); expect(claude.spawns).toHaveLength(1); expect(codex.spawns).toHaveLength(0);
    await sup.setAccount(r.agentId, "cx-main", "gpt-6-astra", true);
    expect(codex.spawns[0]?.acknowledgeCodexFullAccessRisk).toBe(true);
    await sup.kill(r.agentId);
  });

  it("can be cancelled during compaction and blocks overlapping account/model switches", async () => {
    const { sup, claude, codex } = makeMultiProviderSupervisor([running, parked], [parked]);
    const r = await sup.spawn(base);
    await vi.waitFor(() => expect(r.sessionId).toBe("source-session"));
    const switching = sup.setAccount(r.agentId, "cx-main", "gpt-6-astra").catch((error: unknown) => error);
    await vi.waitFor(() => expect(claude.spawns).toHaveLength(2));
    await expect(sup.setAccount(r.agentId, "cx-main")).rejects.toThrow("already in progress");
    await expect(sup.setModel(r.agentId, "opus")).rejects.toThrow("already in progress");
    await sup.kill(r.agentId);
    expect(await switching).toBeInstanceOf(Error);
    expect(sup.status(r.agentId).state).toBe("killed");
    expect(codex.spawns).toHaveLength(0);
  });

  it("uses history when there is no native source session", async () => {
    const { sup, claude, codex } = makeMultiProviderSupervisor([parked], [parked]);
    const r = await sup.spawn(base);
    await sup.reconfigure(r.agentId, { account: "cx-main", model: "gpt-6-astra" });
    expect(claude.spawns).toHaveLength(1);
    expect(codex.spawns[0]?.prompt).toContain("source session is unavailable");
    await sup.kill(r.agentId);
  });

  it("can compact an explicitly held source session too", async () => {
    const { sup, codex } = makeMultiProviderSupervisor([running, [{ end: { resultText: "Retained context from the held session." } }]], [parked]);
    const r = await sup.spawn(base);
    await vi.waitFor(() => expect(r.sessionId).toBe("source-session"));
    await sup.hold(r.agentId);
    await sup.setAccount(r.agentId, "cx-main", "gpt-6-astra");
    expect(codex.spawns[0]?.prompt).toContain("Retained context from the held session");
    await sup.kill(r.agentId);
  });

  it("queues messages arriving during compaction and delivers them to the target", async () => {
    const { sup, claude, codex, events } = makeMultiProviderSupervisor([running, parked], [parked]);
    const r = await sup.spawn(base);
    await vi.waitFor(() => expect(r.sessionId).toBe("source-session"));
    let summarySink: EventSink | undefined;
    const originalSpawn = claude.spawn.bind(claude);
    vi.spyOn(claude, "spawn").mockImplementation((spec, sink, permission, dialog) => {
      summarySink = sink;
      return originalSpawn(spec, sink, permission, dialog);
    });
    const switching = sup.setAccount(r.agentId, "cx-main", "gpt-6-astra");
    await vi.waitFor(() => expect(summarySink).toBeDefined());
    expect(await sup.send(r.agentId, "New constraint: do not touch config.json")).toMatchObject({ delivered: false, ack: "pending" });
    summarySink!({ kind: "result", data: { text: "Portable source summary." } });
    await switching;
    expect(codex.spawns[0]?.prompt).toContain("New constraint: do not touch config.json");
    await vi.waitFor(() => expect(events.tail(r.agentId, 100).some((e) => e.kind === "message_complete" && String(e.data.text).includes("echo:") && String(e.data.text).includes("New constraint"))).toBe(true));
    await sup.kill(r.agentId);
  });

  it("retains a visible source record and its native session if target launch fails", async () => {
    const { sup, codex } = makeMultiProviderSupervisor([running, [{ end: { resultText: "Work remains." } }]], []);
    const r = await sup.spawn(base);
    await vi.waitFor(() => expect(r.sessionId).toBe("source-session"));
    vi.spyOn(codex, "spawn").mockImplementation(() => { throw new Error("target unavailable"); });
    await expect(sup.setAccount(r.agentId, "cx-main", "gpt-6-astra")).rejects.toThrow("target unavailable");
    expect(sup.status(r.agentId)).toMatchObject({ state: "failed", provider: "claude", sessionId: "source-session" });
  });

  it("retains the exact shared worktree for both source compaction and target execution", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chimera-transfer-worktree-"));
    const worktree = join(cwd, ".chimera", "worktrees", "shared");
    mkdirSync(worktree, { recursive: true });
    const { sup, claude, codex } = makeMultiProviderSupervisor([running, [{ end: { resultText: "Use the existing shared worktree." } }]], [parked]);
    const r = await sup.spawn({ ...base, cwd, isolation: "worktree", workdirKey: "shared" });
    await vi.waitFor(() => expect(r.sessionId).toBe("source-session"));
    const next = await sup.setAccount(r.agentId, "cx-main", "gpt-6-astra");
    expect(claude.spawns[1]?.cwd).toBe(worktree);
    expect(next.spec).toMatchObject({ cwd, isolation: "worktree", workdirKey: "shared" });
    expect(codex.spawns[0]?.prompt).toContain(`Working directory is unchanged: ${worktree}`);
    await sup.kill(r.agentId);
  });

  it("refuses a missing worktree instead of silently moving execution to the main checkout", async () => {
    const { sup, claude, codex } = makeMultiProviderSupervisor([running], [parked]);
    const r = await sup.spawn(base);
    r.spec = { ...r.spec, isolation: "worktree", workdirKey: `missing-${r.agentId}` };
    await expect(sup.setAccount(r.agentId, "cx-main", "gpt-6-astra")).rejects.toThrow("working directory no longer exists");
    expect(r.state).toBe("running");
    expect(claude.spawns).toHaveLength(1); expect(codex.spawns).toHaveLength(0);
    await sup.kill(r.agentId);
  });
});
