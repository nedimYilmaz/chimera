import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeStep } from "@chimera/core/backends/fake";
import { UnknownAgentError } from "@chimera/core/supervisor";
import { makeSupervisor } from "./helpers.js";

// REBIND: the cwd counterpart of handoff — move a running/paused/stranded agent to a NEW
// working directory, same provider/account/model throughout. Unlike handoff, carries NO
// isolation:"worktree" guard (its own motivating case is an isolation:"none" default chat
// session with no path bound yet). Two paths: cheap same-agentId respawn (no real history
// yet) vs a portable context package + fresh lineaged agentId (real history exists).

const IDLE: FakeStep[] = [{ awaitSend: true }];   // no message_complete/tool_call/tool_result — "no history"

const RUNNING_WITH_SESSION: FakeStep[] = [
  { emit: { kind: "agent_started", data: { sessionId: "sess-1" } } },
  { emit: { kind: "message_complete", data: { text: "found the bug in file src/foo.ts on branch feature/ABC-1" } } },
  { awaitSend: true },
];

describe("AgentSupervisor.rebind", () => {
  it("throws UnknownAgentError for a ghost/unknown agentId", async () => {
    const { sup } = makeSupervisor([]);
    await expect(sup.rebind("ghost", { cwd: "/tmp" })).rejects.toBeInstanceOf(UnknownAgentError);
  });

  it("no real history yet: cheap respawn under the SAME agentId, no package, resume:null", async () => {
    const { sup, fake, dir } = makeSupervisor([IDLE, IDLE]);
    const rec = await sup.spawn({ prompt: "x", cwd: dir, isolation: "none", account: "main" }, { agentId: "a-1" });
    await new Promise((r) => setTimeout(r, 20));

    const newDir = mkdtempSync(join(tmpdir(), "chimera-rebind-"));
    const next = await sup.rebind("a-1", { cwd: newDir });

    expect(next.agentId).toBe("a-1");            // SAME agentId — nothing real to lose yet
    expect(next.spec.cwd).toBe(newDir);
    expect(next.spec.isolation).toBe("none");
    expect(fake.spawns[1]!.resume).toBe(null);    // old cwd's session (if any) cannot resume at a new cwd
    expect(fake.spawns[1]!.cwd).toBe(newDir);
    expect(rec.agentId).toBe("a-1");
  });

  it("no history + isolation:\"worktree\" default: targets isolation defaults to \"none\" unless overridden", async () => {
    const { sup, fake, dir } = makeSupervisor([IDLE, IDLE]);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "none", account: "main" }, { agentId: "a-2" });
    await new Promise((r) => setTimeout(r, 20));

    const newDir = mkdtempSync(join(tmpdir(), "chimera-rebind-"));
    const next = await sup.rebind("a-2", { cwd: newDir, isolation: "worktree" });
    expect(next.spec.isolation).toBe("worktree");
    expect(fake.spawns[1]!.isolation).toBe("worktree");
  });

  it("no history: a resumeOnly:true idle placeholder stays idle at the new cwd (resumeOnly preserved)", async () => {
    const { sup, fake, dir } = makeSupervisor([IDLE, IDLE]);
    await sup.spawn(
      { prompt: "(placeholder)", cwd: dir, isolation: "none", account: "main", resume: null, resumeOnly: true },
      { agentId: "a-3" },
    );
    await new Promise((r) => setTimeout(r, 20));

    const newDir = mkdtempSync(join(tmpdir(), "chimera-rebind-"));
    await sup.rebind("a-3", { cwd: newDir });
    expect(fake.spawns[1]!.resumeOnly).toBe(true);
    expect(fake.spawns[1]!.prompt).toBe("(placeholder)");   // never sent as a real turn either time
  });

  it("real history exists: mints a FRESH lineaged agentId with a built context package, even from isolation:\"none\" (no worktree guard, unlike handoff)", async () => {
    const { sup, fake, dir } = makeSupervisor([RUNNING_WITH_SESSION, IDLE]);
    await sup.spawn(
      { prompt: "original brief: migrate the widget", cwd: dir, isolation: "none", account: "main", permissionProfile: "acceptEdits" },
      { agentId: "a-4", treeId: "tree-x", depth: 1 },
    );
    await new Promise((r) => setTimeout(r, 20));

    const newDir = mkdtempSync(join(tmpdir(), "chimera-rebind-"));
    const next = await sup.rebind("a-4", { cwd: newDir, note: "keep going on the migration" });

    expect(next.agentId).not.toBe("a-4");             // fresh agentId, not a resume-under-same-id
    expect(next.treeId).toBe("tree-x");                // lineage preserved
    expect(next.depth).toBe(1);
    expect(next.handoffFrom).toBe("a-4");
    expect(next.spec.permissionProfile).toBe("acceptEdits");

    const spawned = fake.spawns[1]!;
    expect(spawned.cwd).toBe(newDir);
    expect(spawned.resume).toBe(null);
    expect(spawned.prompt).not.toBe("original brief: migrate the widget");
    expect(spawned.prompt).toContain("original brief: migrate the widget");
    expect(spawned.prompt).toContain("keep going on the migration");
    expect(spawned.prompt).toContain("feature/ABC-1");
    // honesty: never claims the OLD cwd's on-disk state moved to the new one
    expect(spawned.prompt).toContain(newDir);
    expect(spawned.prompt).toMatch(/NOT.*carried forward|NOT copied/);
  });

  it("settles the source agent \"done\" with handoffTo + reason \"rebind\" (distinct from a provider handoff)", async () => {
    const { sup, dir, events } = makeSupervisor([RUNNING_WITH_SESSION, IDLE]);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "none", account: "main" }, { agentId: "a-5" });
    await new Promise((r) => setTimeout(r, 20));

    const newDir = mkdtempSync(join(tmpdir(), "chimera-rebind-"));
    const next = await sup.rebind("a-5", { cwd: newDir });

    const source = sup.status("a-5");
    expect(source.state).toBe("done");
    expect(source.handoffTo).toBe(next.agentId);
    const tail = events.tail("a-5", 50);
    const settle = tail.find((e) => e.kind === "status" && e.data["state"] === "done" && e.data["handoffTo"]);
    expect(settle?.data["reason"]).toBe("rebind");
    expect(settle?.data["toCwd"]).toBe(newDir);
  });

  it("forwards pending mailbox messages to the target instead of dropping them", async () => {
    const { sup, dir } = makeSupervisor([RUNNING_WITH_SESSION, IDLE]);
    await sup.spawn({ prompt: "x", cwd: dir, isolation: "none", account: "main" }, { agentId: "a-6" });
    await new Promise((r) => setTimeout(r, 20));
    const deps = (sup as unknown as { deps: { mailboxes: { enqueue: (id: string, m: unknown) => void; pending: (id: string) => unknown[] } } }).deps;
    deps.mailboxes.enqueue("a-6", { from: "conductor-1", kind: "user_message", text: "also check the retry path" });

    const newDir = mkdtempSync(join(tmpdir(), "chimera-rebind-"));
    const next = await sup.rebind("a-6", { cwd: newDir });

    expect(deps.mailboxes.pending("a-6")).toHaveLength(0);
    const forwarded = deps.mailboxes.pending(next.agentId);
    expect(forwarded).toHaveLength(1);
  });
});
