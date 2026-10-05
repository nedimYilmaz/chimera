import { describe, it, expect, vi } from "vitest";
import { RPC_CONTRACT, isContractMethod, buildFamilyClient, validateRpcResponse } from "@chimera/protocol/contract";
import { TaskRecordSchema, TaskSummarySchema } from "@chimera/protocol";

// Shared with the buildFamilyClient describe block below (TYPED-CLIENT-SDK) so the two lists
// can't silently drift apart — a family-grouping regression and a plain contract-membership
// regression would otherwise need two separate hand-edits to stay in sync.
const ALL_METHODS = [
  // Workspace evolution: typed RPCs for groups, branching, layout, remote operator,
  // context links, worktree editing, issue sources and local speech.
  "agent.setGroups", "agent.addGroups", "agent.removeGroups", "agent.forkCapabilities", "agent.fork", "agent.resources",
  "canvas.get", "canvas.saveLayout",
  "group.list", "group.create", "group.update", "group.delete",
  "host.admission",
  "contextlink.create", "contextlink.list", "contextlink.get", "contextlink.revoke",
  "operatorweb.operatorStatus", "operatorweb.status", "operatorweb.enable", "operatorweb.disable",
  "operatorweb.pairStart", "operatorweb.sessionList", "operatorweb.sessionRevoke", "operatorweb.settingsSet",
  "worktree.gitStatus", "worktree.gitDiff", "worktree.fileRead", "worktree.fileWrite", "worktree.gitStage", "worktree.gitCommit",
  "issues.sourceList", "issues.sourceUpsert", "issues.sourceRemove", "issues.sync", "issues.linkList", "issues.postComment",
  "stt.status", "stt.configure", "stt.install", "stt.installCancel", "stt.uninstall", "stt.transcribe", "stt.transcribeCancel",
  "artifact.add", "artifact.get", "artifact.list",
  "audit.verify", "events.search", "events.searchExport", "evidence.get",
  // F50 BUDGET-RESUME: operator-only — it is in the RPC contract but deliberately in NO MCP tool
  // table, which is what keeps it out of every agent's reach.
  "budget.resume",
  // CHRONICLE-SEMANTIC: semantic search over DISTILLED event history, which outlives the log's own
  // pruning. Distinct from events.search (lexical, only over what the log still retains).
  "chronicle.search", "chronicle.get", "chronicle.status", "chronicle.reindex",
  // SKILL-DISCOVERY: find a skill by what it does, load its text when it is wanted.
  "skill.search", "skill.read",
  // TERMINAL-READBACK: the app tees PTY output in (append), the agent reads the tail (read).
  "terminal.append", "terminal.read", "terminal.write", "terminal.tabState",
  "health.status", "replay.agentsAsOf",
  // F13: read-only join over agents/tasks/jobs/journal/rollup — a query, never a new store.
  "history.runs",
  // HOOK-CRUD-RPC: atomic CRUD over ChimeraConfig.hooks — the agent-facing counterpart of the
  // config.get/config.patch pair the desktop HooksCard still uses.
  "hook.create", "hook.delete", "hook.list", "hook.setEnabled", "hook.update",
  // F11.2: durable step journal query RPC.
  "journal.query",
  "mcpstore.oauth.start", "mcpstore.oauth.finish", "mcpstore.oauth.cancel",
  "queue.addDependency", "queue.cancelTask", "queue.create", "queue.delete", "queue.editTask", "queue.explainTask", "queue.list",
  "queue.moveTask", "queue.pause", "queue.push", "queue.requeue", "queue.requestRemediation", "queue.resume", "queue.retryTask",
  "queue.status", "queue.statusSummary", "queue.update",
  "review.decide", "review.finding.add", "review.finding.resolve", "review.get",
  "role.create", "role.delete", "role.list", "role.update",
  "shadow.workflowInspect",
  "sub.create", "sub.list", "sub.remove",
  "team.attachRole", "team.create", "team.detachRole", "team.dissolve", "team.list", "team.mine", "team.status", "team.update", "team.updateRoleBinding",
  "voice.conversation.set", "voice.realtime.token", "voice.session.start", "voice.session.stop",
  "voice.native.check", "voice.native.configure", "voice.native.start", "voice.native.poll", "voice.native.stop",
  "voice.native.history", "voice.native.request", "voice.native.requests", "voice.native.dismiss", "voice.native.end",
  "voice.native.text", "voice.room.create", "voice.room.list", "voice.room.update", "voice.room.end", "voice.room.delete", "voice.room.approve", "voice.room.reviewUpdate", "voice.room.heartbeat", "voice.room.report", "voice.room.plan", "voice.room.cancelPlan", "voice.room.removeParticipant",
  "workflow.create", "workflow.delete", "workflow.list", "workflow.plan", "workflow.run", "workflow.update",
  // F22 single-writer worktree lease: list/handoff/release over the lease store in engine.ts.
  // QA of F15/F22: explainWrite is the read-only dry-run of the same write gate.
  "worktree.explainWrite", "worktree.leaseHandoff", "worktree.leaseList", "worktree.leaseRelease",
].sort();

describe("RPC_CONTRACT (FEATURE-8)", () => {
  it("pins every typed RPC method — a regression net for accidental additions/removals", () => {
    expect(Object.keys(RPC_CONTRACT).sort()).toEqual(ALL_METHODS);
  });

  it("isContractMethod recognizes contract methods and rejects everything else", () => {
    expect(isContractMethod("queue.create")).toBe(true);
    expect(isContractMethod("team.create")).toBe(true);
    expect(isContractMethod("workflow.create")).toBe(true);
    expect(isContractMethod("artifact.add")).toBe(true);
    expect(isContractMethod("review.decide")).toBe(true);
    expect(isContractMethod("project.create")).toBe(false);
    expect(isContractMethod("bogus.method")).toBe(false);
  });

  describe("queue.create", () => {
    const { request, response } = RPC_CONTRACT["queue.create"];
    it("request: accepts a minimal spec, applying QueueSpecSchema defaults", () => {
      const parsed = request.parse({ spec: { name: "work" } });
      expect(parsed).toEqual({ spec: { name: "work", retryLimit: 2, workflow: null, paused: false } });
    });
    it("request: rejects a missing spec", () => {
      expect(() => request.parse({})).toThrow();
    });
    it("request: rejects an unknown top-level field (strict)", () => {
      expect(() => request.parse({ spec: { name: "work" }, bogus: 1 })).toThrow();
    });
    it("response: round-trips a QueueSpec", () => {
      expect(response.parse({ name: "work", retryLimit: 2, workflow: null }))
        .toEqual({ name: "work", retryLimit: 2, workflow: null, paused: false });
    });
    it("response: rejects a shape missing a required field", () => {
      expect(() => response.parse({ name: "work" })).not.toThrow();   // retryLimit/workflow/paused default
      expect(() => response.parse({ retryLimit: 2, workflow: null })).toThrow();   // name is required
    });
  });

  describe("queue.list", () => {
    const { request, response } = RPC_CONTRACT["queue.list"];
    it("request: only the empty object", () => {
      expect(request.parse({})).toEqual({});
      expect(() => request.parse({ queue: "x" })).toThrow();
    });
    it("response: an array of QueueSpec", () => {
      const parsed = response.parse([{ name: "a" }, { name: "b", retryLimit: 5 }]);
      expect(parsed).toEqual([
        { name: "a", retryLimit: 2, workflow: null, paused: false },
        { name: "b", retryLimit: 5, workflow: null, paused: false },
      ]);
    });
  });

  describe("queue.update", () => {
    const { request, response } = RPC_CONTRACT["queue.update"];
    it("request: requires name, accepts a sparse patch", () => {
      expect(request.parse({ name: "work", patch: {} })).toEqual({ name: "work", patch: {} });
      expect(() => request.parse({ patch: {} })).toThrow();
    });
    it("request: rejects an unknown patch field (strict, mirrors old QueueUpdateParams)", () => {
      expect(() => request.parse({ name: "work", patch: { bogus: 1 } })).toThrow();
    });
    it("response: a full QueueSpec", () => {
      expect(response.parse({ name: "work", retryLimit: 3, workflow: "release" }))
        .toEqual({ name: "work", retryLimit: 3, workflow: "release", paused: false });
    });
  });

  describe("queue.pause / queue.resume (QUEUE-PAUSE)", () => {
    it("queue.pause request: requires a non-empty queue, strict", () => {
      const { request } = RPC_CONTRACT["queue.pause"];
      expect(() => request.parse({})).toThrow();
      expect(() => request.parse({ queue: "" })).toThrow();
      expect(() => request.parse({ queue: "work", bogus: 1 })).toThrow();
      expect(request.parse({ queue: "work" })).toEqual({ queue: "work" });
    });
    it("queue.resume request: requires a non-empty queue, strict", () => {
      const { request } = RPC_CONTRACT["queue.resume"];
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ queue: "work" })).toEqual({ queue: "work" });
    });
    it("both respond with a full QueueSpec", () => {
      const { response: pauseResponse } = RPC_CONTRACT["queue.pause"];
      const { response: resumeResponse } = RPC_CONTRACT["queue.resume"];
      expect(pauseResponse.parse({ name: "work", retryLimit: 2, workflow: null, paused: true }))
        .toEqual({ name: "work", retryLimit: 2, workflow: null, paused: true });
      expect(resumeResponse.parse({ name: "work", retryLimit: 2, workflow: null, paused: false }))
        .toEqual({ name: "work", retryLimit: 2, workflow: null, paused: false });
    });
  });

  describe("queue.delete", () => {
    const { request, response } = RPC_CONTRACT["queue.delete"];
    it("request: requires name", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ name: "work" })).toEqual({ name: "work" });
    });
    it("response: { deleted: boolean }", () => {
      expect(response.parse({ deleted: true })).toEqual({ deleted: true });
      expect(() => response.parse({ deleted: "yes" })).toThrow();
    });
  });

  describe("queue.push", () => {
    const { request, response } = RPC_CONTRACT["queue.push"];
    it("request: requires queue+prompt, accepts an unknown extra field (NOT strict, mirrors old QueuePushParams)", () => {
      expect(() => request.parse({ queue: "work" })).toThrow();   // prompt missing
      const parsed = request.parse({ queue: "work", prompt: "do it", extra: "ignored" });
      expect(parsed.queue).toBe("work");
      expect(parsed.prompt).toBe("do it");
    });
    it("response: a full TaskRecord", () => {
      const rec = {
        taskId: "t1", queue: "work", prompt: "do it", role: null, overrides: {}, priority: 0, orderKey: 0, tags: [],
        state: "pending", dependsOn: [], attempts: 0, createdAt: 1, pushedBy: null, originConductorId: null, agentId: null,
        resultText: null, error: null, workflowOverride: null, workflow: null, stepIndex: 0,
        stepAttempts: 0, remediationRounds: 0, remediationGateStep: null, pendingRemediationRequest: null, stepHistory: [], parentTaskId: null, branchChildren: [], fanOutRemaining: [], loopIterations: {}, checkpoint: null, versions: [], cause: null,
      };
      expect(response.parse(rec)).toEqual(rec);
    });
  });

  describe("queue.status", () => {
    const { request, response } = RPC_CONTRACT["queue.status"];
    it("request: accepts an unrecognized extra field (NOT strict, mirrors old QueueNameParams)", () => {
      expect(request.parse({ queue: "work", extra: 1 })).toMatchObject({ queue: "work" });
    });
    it("response: {spec, counts, tasks}, strict", () => {
      const status = {
        spec: { name: "work", retryLimit: 2, workflow: null, paused: false },
        counts: { pending: 1, in_progress: 0, done: 0, failed: 0, blocked: 0, dead_letter: 0 },
        tasks: [],
      };
      expect(response.parse(status)).toEqual(status);
      expect(() => response.parse({ ...status, bogus: 1 })).toThrow();
    });

    // QUEUE-STATUS-RENAMES-ITS-OWN-ID: queue.status's TaskRecord identifies a task via `taskId`
    // while queue.statusSummary's TaskSummary uses `id` for the same entity — a deliberate
    // full-vs-projection naming convention (mirrored by agent.list's `agentId` vs
    // agent.listSummary's `id`), NOT accidental drift. Pin both names so a future edit can't
    // silently rename one without the other tripping this test.
    it("TaskRecord (full) keys its identifier `taskId`; TaskSummary (projection) keys it `id` — deliberate, not drift", () => {
      expect(TaskRecordSchema.shape.taskId).toBeDefined();
      expect((TaskRecordSchema.shape as Record<string, unknown>).id).toBeUndefined();
      expect(TaskSummarySchema.shape.id).toBeDefined();
      expect((TaskSummarySchema.shape as Record<string, unknown>).taskId).toBeUndefined();
    });
  });

  describe("queue.statusSummary", () => {
    const { request, response } = RPC_CONTRACT["queue.statusSummary"];
    it("request: caps limit at 200 (mirrors old QueueStatusSummaryParams)", () => {
      expect(() => request.parse({ queue: "work", limit: 500 })).toThrow();
      expect(request.parse({ queue: "work", limit: 50 })).toEqual({ queue: "work", limit: 50 });
    });
    it("response: {spec, counts, tasks: TaskSummary[], nextCursor}", () => {
      const summary = {
        spec: { name: "work", retryLimit: 2, workflow: null, paused: false },
        counts: { pending: 0, in_progress: 0, done: 1, failed: 0, blocked: 0, dead_letter: 0 },
        tasks: [{ id: "t1", state: "done", subject: "do it" }],
        nextCursor: null,
      };
      expect(response.parse(summary)).toEqual(summary);
    });
  });

  describe("queue.cancelTask", () => {
    const { request, response } = RPC_CONTRACT["queue.cancelTask"];
    it("request: requires taskId", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ taskId: "t1" })).toEqual({ taskId: "t1" });
    });
    it("response: { cancelled: boolean }", () => {
      expect(response.parse({ cancelled: false })).toEqual({ cancelled: false });
    });
  });

  describe("queue.requeue", () => {
    const { request, response } = RPC_CONTRACT["queue.requeue"];
    it("request: requires taskId, strict", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ taskId: "t1" })).toEqual({ taskId: "t1" });
      expect(() => request.parse({ taskId: "t1", bogus: 1 })).toThrow();
    });
    it("response: a full TaskRecord", () => {
      const rec = {
        taskId: "t1", queue: "work", prompt: "do it", role: null, overrides: {}, priority: 0, orderKey: 0, tags: [],
        state: "pending", dependsOn: [], attempts: 0, createdAt: 1, pushedBy: null, originConductorId: null, agentId: null,
        resultText: null, error: null, workflowOverride: null, workflow: null, stepIndex: 0,
        stepAttempts: 0, remediationRounds: 0, remediationGateStep: null, pendingRemediationRequest: null, stepHistory: [], parentTaskId: null, branchChildren: [], fanOutRemaining: [], loopIterations: {}, checkpoint: null, versions: [], cause: null,
      };
      expect(response.parse(rec)).toEqual(rec);
    });
  });

  describe("evidence.get (FEATURE-10)", () => {
    const { request, response } = RPC_CONTRACT["evidence.get"];
    it("request: requires a non-empty taskId, strict", () => {
      expect(() => request.parse({})).toThrow();
      expect(() => request.parse({ taskId: "" })).toThrow();
      expect(() => request.parse({ taskId: "t1", bogus: 1 })).toThrow();
      expect(request.parse({ taskId: "t1" })).toEqual({ taskId: "t1" });
    });
    it("response: a full TaskEvidence, with an available:false diff (no extra fields allowed)", () => {
      const evidence = {
        taskId: "t1", queue: "work", state: "pending", workflow: null,
        steps: [], artifacts: [],
        provenance: [{
          worktreeKey: "agent-1", branch: "chimera/agent-1", mainRepo: "/repo", agentIds: ["agent-1"],
          diff: { available: false, reason: "no live worktree and no merge commit found" },
        }],
      };
      expect(response.parse(evidence)).toEqual(evidence);
      const badDiff = { ...evidence, provenance: [{ ...evidence.provenance[0], diff: { available: false, reason: "x", baseSha: "abc" } }] };
      expect(() => response.parse(badDiff)).toThrow();   // available:false branch is strict — no baseSha allowed
    });
    it("response: an available:true diff round-trips with files/stat/dirty", () => {
      const evidence = {
        taskId: "t1", queue: "work", state: "done", workflow: { name: "wf", version: 1 },
        steps: [{
          stepIndex: 0, stepId: "s0", title: "build", agentId: "a1", startedAt: 1, endedAt: 2,
          outcome: "passed", reason: null, handoffSummary: null, gate: { kind: "command", spec: { command: "true" } },
        }],
        artifacts: [],
        provenance: [{
          worktreeKey: "agent-1", branch: "chimera/agent-1", mainRepo: "/repo", agentIds: ["agent-1"],
          diff: {
            available: true, source: "live", baseSha: "aaa", headSha: "bbb", mergeCommitSha: null,
            files: [{ path: "a.ts", status: "modified", insertions: 3, deletions: 1 }],
            patches: [], patchTruncated: false,
            statText: "a.ts | 4 ++--", truncated: false, dirty: 0,
          },
        }],
      };
      expect(response.parse(evidence)).toEqual(evidence);
    });
    it("response: rejects a source outside the enum / an insertions count below 0", () => {
      const base = {
        taskId: "t1", queue: "work", state: "pending", workflow: null, steps: [], artifacts: [],
      };
      expect(() => response.parse({
        ...base,
        provenance: [{ worktreeKey: "k", branch: "b", mainRepo: null, agentIds: [], diff: {
          available: true, source: "bogus", baseSha: "a", headSha: "b", mergeCommitSha: null, files: [], statText: "", truncated: false, dirty: null,
        } }],
      })).toThrow();
      expect(() => response.parse({
        ...base,
        provenance: [{ worktreeKey: "k", branch: "b", mainRepo: null, agentIds: [], diff: {
          available: true, source: "live", baseSha: "a", headSha: "b", mergeCommitSha: null,
          files: [{ path: "x", status: "added", insertions: -1, deletions: 0 }], statText: "", truncated: false, dirty: null,
        } }],
      })).toThrow();
    });
  });

  // ---------- team.* (FEATURE-11, ROLES-UNIFY §2/§3.1) ----------
  // A role slot is now a RoleBindingSchema reference ({role, overrides}), not a materialized
  // AgentSpec-shaped copy.
  const ROLE = { role: "dev" };

  describe("team.create", () => {
    const { request, response } = RPC_CONTRACT["team.create"];
    it("request: accepts a minimal spec, applying TeamSpecSchema defaults", () => {
      const parsed = request.parse({ spec: { name: "crew", roles: { dev: ROLE } } });
      expect(parsed.spec).toMatchObject({ name: "crew", maxConcurrent: 4, queue: null, purpose: null });
      expect(parsed.spec.roles.dev).toEqual({ role: "dev", overrides: {} });
    });
    it("request: rejects a spec with zero roles", () => {
      expect(() => request.parse({ spec: { name: "crew", roles: {} } })).toThrow();
    });
    it("request: rejects an unknown top-level field (strict)", () => {
      expect(() => request.parse({ spec: { name: "crew", roles: { dev: ROLE } }, bogus: 1 })).toThrow();
    });
    it("response: round-trips a TeamSpec", () => {
      const spec = request.parse({ spec: { name: "crew", roles: { dev: ROLE } } }).spec;
      expect(response.parse(spec)).toEqual(spec);
    });
  });

  describe("team.list", () => {
    const { request, response } = RPC_CONTRACT["team.list"];
    it("request: only the empty object", () => {
      expect(request.parse({})).toEqual({});
      expect(() => request.parse({ team: "x" })).toThrow();
    });
    it("response: an array of TeamSpec + running", () => {
      const spec = RPC_CONTRACT["team.create"].request.parse({ spec: { name: "crew", roles: { dev: ROLE } } }).spec;
      const parsed = response.parse([{ ...spec, running: 2, totalRuns: 5 }]);
      expect(parsed).toEqual([{ ...spec, running: 2, totalRuns: 5 }]);
    });
  });

  describe("team.status", () => {
    const { request, response } = RPC_CONTRACT["team.status"];
    it("request: name, not strict (mirrors old TeamNameParams)", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ name: "crew", extra: 1 })).toMatchObject({ name: "crew" });
    });
    it("response: {spec, running, agents[]}, strict at the top level", () => {
      const spec = RPC_CONTRACT["team.create"].request.parse({ spec: { name: "crew", roles: { dev: ROLE } } }).spec;
      const status = { spec, running: 0, totalRuns: 0, agents: [{ agentId: null, phase: "not_spawned", runCount: 0 }] };
      expect(response.parse(status)).toEqual(status);
      expect(() => response.parse({ ...status, bogus: 1 })).toThrow();
    });
  });

  describe("team.dissolve", () => {
    const { request, response } = RPC_CONTRACT["team.dissolve"];
    it("request: name, not strict", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ name: "crew" })).toMatchObject({ name: "crew" });
    });
    it("response: { ok: true } only — the literal, not any boolean", () => {
      expect(response.parse({ ok: true })).toEqual({ ok: true });
      expect(() => response.parse({ ok: false })).toThrow();
    });
  });

  describe("team.update", () => {
    const { request, response } = RPC_CONTRACT["team.update"];
    it("request: requires name, accepts a sparse patch", () => {
      expect(request.parse({ name: "crew", patch: {} })).toEqual({ name: "crew", patch: {} });
      expect(() => request.parse({ patch: {} })).toThrow();
    });
    it("request: rejects an unknown patch field (strict, mirrors old TeamUpdateParams)", () => {
      expect(() => request.parse({ name: "crew", patch: { bogus: 1 } })).toThrow();
    });
    it("response: a full TeamSpec", () => {
      const spec = RPC_CONTRACT["team.create"].request.parse({ spec: { name: "crew", roles: { dev: ROLE } } }).spec;
      expect(response.parse(spec)).toEqual(spec);
    });
  });

  describe("team.attachRole", () => {
    const { request, response } = RPC_CONTRACT["team.attachRole"];
    it("request: requires team + role, accepts optional as/cwd (strict)", () => {
      expect(request.parse({ team: "crew", role: "reviewer" })).toEqual({ team: "crew", role: "reviewer" });
      expect(request.parse({ team: "crew", role: "reviewer", as: "rev2", cwd: "/tmp/x" }))
        .toEqual({ team: "crew", role: "reviewer", as: "rev2", cwd: "/tmp/x" });
      expect(() => request.parse({ role: "reviewer" })).toThrow();
      expect(() => request.parse({ team: "crew", role: "reviewer", bogus: 1 })).toThrow();
    });
    it("response: a full TeamSpec", () => {
      const spec = RPC_CONTRACT["team.create"].request.parse({ spec: { name: "crew", roles: { dev: ROLE } } }).spec;
      expect(response.parse(spec)).toEqual(spec);
    });
  });

  describe("team.detachRole", () => {
    const { request, response } = RPC_CONTRACT["team.detachRole"];
    it("request: requires team + role, strict", () => {
      expect(request.parse({ team: "crew", role: "reviewer" })).toEqual({ team: "crew", role: "reviewer" });
      expect(() => request.parse({ team: "crew" })).toThrow();
      expect(() => request.parse({ team: "crew", role: "reviewer", bogus: 1 })).toThrow();
    });
    it("response: a full TeamSpec", () => {
      const spec = RPC_CONTRACT["team.create"].request.parse({ spec: { name: "crew", roles: { dev: ROLE } } }).spec;
      expect(response.parse(spec)).toEqual(spec);
    });
  });

  // ROLES-UNIFY §2/§3.1: TeamSpecSchema.roles[key] is a RoleBindingSchema reference, not a
  // materialized copy — `sharedRoles` is REMOVED (a one-way protocol break, §9.3), a binding's
  // own `role` field is now the sole provenance.
  it("TeamSpecSchema: roles[key] round-trips as a {role, overrides} binding, no sharedRoles field", () => {
    const spec = RPC_CONTRACT["team.create"].request.parse({ spec: { name: "crew", roles: { dev: ROLE } } }).spec;
    expect(spec.roles.dev).toEqual({ role: "dev", overrides: {} });
    expect(Object.keys(spec)).not.toContain("sharedRoles");
  });

  describe("team.updateRoleBinding", () => {
    const { request, response } = RPC_CONTRACT["team.updateRoleBinding"];
    it("request: requires team + roleKey, accepts optional role/overrides (strict)", () => {
      expect(request.parse({ team: "crew", roleKey: "dev" })).toEqual({ team: "crew", roleKey: "dev" });
      expect(request.parse({ team: "crew", roleKey: "dev", role: "chimera-dev.worker", overrides: { model: "opus" } }))
        .toEqual({ team: "crew", roleKey: "dev", role: "chimera-dev.worker", overrides: { model: "opus" } });
      expect(() => request.parse({ roleKey: "dev" })).toThrow();
      expect(() => request.parse({ team: "crew", roleKey: "dev", bogus: 1 })).toThrow();
    });
    it("request: role must satisfy RoleNameSchema (zero or one dot)", () => {
      expect(() => request.parse({ team: "crew", roleKey: "dev", role: "a.b.c" })).toThrow();
      expect(request.parse({ team: "crew", roleKey: "dev", role: "chimera-dev.worker" }).role).toBe("chimera-dev.worker");
    });
    it("response: a full TeamSpec", () => {
      const spec = RPC_CONTRACT["team.create"].request.parse({ spec: { name: "crew", roles: { dev: ROLE } } }).spec;
      expect(response.parse(spec)).toEqual(spec);
    });
  });

  // ---------- role.* (ad-hoc sessions design §4, widened by ROLES-UNIFY §2/§5) ----------
  describe("role.create", () => {
    const { request, response } = RPC_CONTRACT["role.create"];
    it("request: accepts a minimal spec, applying RoleSpecSchema defaults", () => {
      const parsed = request.parse({ spec: { name: "aws" } });
      expect(parsed.spec).toMatchObject({ name: "aws", skills: [] });
    });
    it("request: rejects an unknown top-level field (strict)", () => {
      expect(() => request.parse({ spec: { name: "aws" }, bogus: 1 })).toThrow();
    });
    it("request: rejects a dotted name — the qualifier namespace is reserved for team migration (§3.2)", () => {
      expect(() => request.parse({ spec: { name: "chimera-dev.worker" } })).toThrow(
        /cannot contain '\.'.*reserved for team-qualified library entries/,
      );
    });
    it("response: round-trips a RoleSpec", () => {
      const spec = request.parse({ spec: { name: "aws" } }).spec;
      expect(response.parse(spec)).toEqual(spec);
    });
  });

  describe("role.list", () => {
    const { request, response } = RPC_CONTRACT["role.list"];
    it("request: only the empty object", () => {
      expect(request.parse({})).toEqual({});
      expect(() => request.parse({ name: "x" })).toThrow();
    });
    it("response: an array of RoleSpec", () => {
      const spec = RPC_CONTRACT["role.create"].request.parse({ spec: { name: "aws" } }).spec;
      expect(response.parse([spec])).toEqual([spec]);
    });
  });

  describe("role.update", () => {
    const { request, response } = RPC_CONTRACT["role.update"];
    it("request: requires name, accepts a sparse patch", () => {
      expect(request.parse({ name: "aws", patch: {} })).toEqual({ name: "aws", patch: {} });
      expect(() => request.parse({ patch: {} })).toThrow();
    });
    it("request: rejects an unknown patch field (strict)", () => {
      expect(() => request.parse({ name: "aws", patch: { bogus: 1 } })).toThrow();
    });
    it("request: accepts a patch over the widened RoleSpec field set (beyond the old picked subset)", () => {
      const patch = { cwd: "/tmp", effort: "high", persistent: true, poolSize: 2, orchestration: { allow: true, maxDepth: 3 } };
      expect(request.parse({ name: "aws", patch })).toEqual({ name: "aws", patch });
    });
    // LEAN-AGENT-MCPS: hand-declared .optional() with no .default() on the patch (mirrors
    // mcpToolAllowlist just above it in contract.ts) — an absent key must leave the field
    // untouched on the stored role, never silently reset it via a re-applied schema default.
    it("request: accepts a strictMcpConfig patch, independent of inherit.settingSources", () => {
      const patch = { strictMcpConfig: true, inherit: { settingSources: ["project", "user"] } };
      expect(request.parse({ name: "aws", patch })).toEqual({ name: "aws", patch });
    });
    it("response: a full RoleSpec", () => {
      const spec = RPC_CONTRACT["role.create"].request.parse({ spec: { name: "aws" } }).spec;
      expect(response.parse(spec)).toEqual(spec);
    });
  });

  describe("role.delete", () => {
    const { request, response } = RPC_CONTRACT["role.delete"];
    it("request: name, strict", () => {
      expect(() => request.parse({})).toThrow();
      expect(() => request.parse({ name: "aws", extra: 1 })).toThrow();
      expect(request.parse({ name: "aws" })).toEqual({ name: "aws" });
    });
    it("response: { ok: true } only", () => {
      expect(response.parse({ ok: true })).toEqual({ ok: true });
      expect(() => response.parse({ ok: false })).toThrow();
    });
  });

  // ---------- workflow.* (FEATURE-11) ----------
  const STEPS = [{ id: "s0", title: "plan", gate: { kind: "none" }, context: "handoff" as const }];

  describe("workflow.create", () => {
    const { request, response } = RPC_CONTRACT["workflow.create"];
    it("request: accepts a minimal spec, strict", () => {
      const parsed = request.parse({ spec: { name: "release", steps: STEPS } });
      expect(parsed.spec.name).toBe("release");
      expect(() => request.parse({ spec: { name: "release", steps: STEPS }, bogus: 1 })).toThrow();
    });
    it("request: rejects zero steps", () => {
      expect(() => request.parse({ spec: { name: "release", steps: [] } })).toThrow();
    });
    it("response: a WorkflowRecord (version + createdAt), strict", () => {
      const record = { name: "release", steps: STEPS, retryLimit: 2, onFail: "halt", params: [], ephemeral: false, version: 1, createdAt: 1 };
      expect(response.parse(record)).toEqual(record);
      expect(() => response.parse({ ...record, bogus: 1 })).toThrow();
    });
  });

  describe("workflow.list", () => {
    const { request, response } = RPC_CONTRACT["workflow.list"];
    it("request: only the empty object", () => {
      expect(request.parse({})).toEqual({});
    });
    it("response: an array of WorkflowRecord", () => {
      const record = { name: "release", steps: STEPS, retryLimit: 2, onFail: "halt", params: [], ephemeral: false, version: 1, createdAt: 1 };
      expect(response.parse([record])).toEqual([record]);
    });
  });

  describe("workflow.update", () => {
    const { request, response } = RPC_CONTRACT["workflow.update"];
    it("request: requires name, accepts a sparse patch (reuses protocol's own WorkflowUpdateParams)", () => {
      expect(request.parse({ name: "release", patch: {} })).toEqual({ name: "release", patch: {} });
      expect(() => request.parse({ patch: {} })).toThrow();
    });
    it("response: a WorkflowRecord with a bumped version", () => {
      const record = { name: "release", steps: STEPS, retryLimit: 2, onFail: "halt", params: [], ephemeral: false, version: 2, createdAt: 1 };
      expect(response.parse(record)).toEqual(record);
    });
  });

  describe("workflow.delete", () => {
    const { request, response } = RPC_CONTRACT["workflow.delete"];
    it("request: name, not strict (mirrors old WorkflowNameParams)", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ name: "release", extra: 1 })).toMatchObject({ name: "release" });
    });
    it("response: { deleted: boolean }", () => {
      expect(response.parse({ deleted: true })).toEqual({ deleted: true });
    });
  });

  describe("workflow.run (FEATURE WORKFLOW-RUN-P1)", () => {
    const { request, response } = RPC_CONTRACT["workflow.run"];
    it("request: requires spec+prompt, strict", () => {
      const parsed = request.parse({ spec: { steps: STEPS }, prompt: "go" });
      expect(parsed.spec.steps).toEqual(STEPS);
      expect(() => request.parse({ spec: { steps: STEPS }, prompt: "go", bogus: 1 })).toThrow();
      expect(() => request.parse({ spec: { steps: STEPS } })).toThrow();   // prompt missing
    });
    it("request: rejects an invalid graph (fanOut+next both set) at parse time — before any handler runs", () => {
      const badSteps = [
        { id: "s0", title: "a", gate: { kind: "none" }, next: [{ to: "s1" }], fanOut: { source: { kind: "list", items: ["x"] }, joinStep: "s1" } },
        { id: "s1", title: "b", gate: { kind: "none" } },
      ];
      expect(() => request.parse({ spec: { steps: badSteps }, prompt: "go" })).toThrow();
    });
    it("queue/role/priority/dependsOn/provision/overrides/agentId are all optional", () => {
      const parsed = request.parse({ spec: { steps: STEPS }, prompt: "go", queue: "q", provision: true, agentId: "a1" });
      expect(parsed).toMatchObject({ queue: "q", provision: true, agentId: "a1" });
    });
    it("response: a full TaskRecord", () => {
      const rec = {
        taskId: "t1", queue: "work", prompt: "go", role: null, overrides: {}, priority: 0, orderKey: 0, tags: [],
        state: "pending", dependsOn: [], attempts: 0, createdAt: 1, pushedBy: null, originConductorId: null, agentId: null,
        resultText: null, error: null, workflowOverride: "run-x", workflow: null, stepIndex: 0,
        stepAttempts: 0, remediationRounds: 0, remediationGateStep: null, pendingRemediationRequest: null, stepHistory: [], parentTaskId: null, branchChildren: [], fanOutRemaining: [], loopIterations: {}, checkpoint: null, versions: [], cause: null,
      };
      expect(response.parse(rec)).toEqual(rec);
    });
  });

  // ---------- artifact.* (FEATURE-11) ----------
  describe("artifact.add", () => {
    const { request, response } = RPC_CONTRACT["artifact.add"];
    it("request: requires kind+label, not strict (mirrors old ArtifactAddParams)", () => {
      expect(() => request.parse({ kind: "link" })).toThrow();   // label missing
      const parsed = request.parse({ kind: "link", url: "https://x", label: "l", extra: 1 });
      expect(parsed).toMatchObject({ kind: "link", url: "https://x", label: "l" });
    });
    it("response: a full ArtifactRecord, strict", () => {
      const rec = {
        id: "a1", kind: "link", label: "l", agentId: null, taskId: null,
        createdAt: 1, sizeBytes: null, path: null, url: "https://x",
      };
      expect(response.parse(rec)).toEqual(rec);
      expect(() => response.parse({ ...rec, bogus: 1 })).toThrow();
    });
  });

  describe("artifact.list", () => {
    const { request, response } = RPC_CONTRACT["artifact.list"];
    it("request: taskId/agentId both optional, not strict", () => {
      expect(request.parse({})).toEqual({});
      expect(request.parse({ taskId: "t1", extra: 1 })).toMatchObject({ taskId: "t1" });
    });
    it("response: an array of ArtifactRecord", () => {
      const rec = {
        id: "a1", kind: "link", label: "l", agentId: null, taskId: null,
        createdAt: 1, sizeBytes: null, path: null, url: "https://x",
      };
      expect(response.parse([rec])).toEqual([rec]);
    });
  });

  describe("artifact.get", () => {
    const { request, response } = RPC_CONTRACT["artifact.get"];
    it("request: requires a non-empty id, not strict (mirrors old ArtifactIdParams)", () => {
      expect(() => request.parse({})).toThrow();
      expect(() => request.parse({ id: "" })).toThrow();
      expect(request.parse({ id: "a1", extra: 1 })).toMatchObject({ id: "a1" });
    });
    it("response: a full ArtifactRecord", () => {
      const rec = {
        id: "a1", kind: "file", label: "l", agentId: "ag1", taskId: "t1",
        createdAt: 1, sizeBytes: 9, path: "/x/f.md", url: null, stepIndex: 3,
      };
      expect(response.parse(rec)).toEqual(rec);
    });
  });

  describe("health.status (R2 self-healing supervision)", () => {
    const { request, response } = RPC_CONTRACT["health.status"];
    it("request: empty, strict", () => {
      expect(request.parse({})).toEqual({});
      expect(() => request.parse({ extra: 1 })).toThrow();
    });
    it("response: an array of AgentHealth rows, strict", () => {
      const row = { agentId: "a1", state: "paused", crashCount: 2, circuitOpen: false, pauseReason: "crash-loop-backoff" };
      expect(response.parse([row])).toEqual([row]);
      expect(() => response.parse([{ ...row, bogus: 1 }])).toThrow();
    });
    it("response: pauseReason is nullable", () => {
      const row = { agentId: "a1", state: "running", crashCount: 0, circuitOpen: false, pauseReason: null };
      expect(response.parse([row])).toEqual([row]);
    });
  });

  describe("replay.agentsAsOf (R2 self-healing supervision)", () => {
    const { request, response } = RPC_CONTRACT["replay.agentsAsOf"];
    it("request: toSeq is optional and positive, not strict", () => {
      expect(request.parse({})).toEqual({});
      expect(request.parse({ toSeq: 5, extra: 1 })).toMatchObject({ toSeq: 5 });
      expect(() => request.parse({ toSeq: 0 })).toThrow();
      expect(() => request.parse({ toSeq: -1 })).toThrow();
    });
    it("response: a loose array of records (no AgentRecordSchema exists yet)", () => {
      expect(response.parse([{ agentId: "a1", state: "running", anything: "goes" }])).toEqual([
        { agentId: "a1", state: "running", anything: "goes" },
      ]);
    });
  });

  // ---------- sub.* (HOOK-2, PLAN-HOOKS.md §2/§6.1) ----------
  // Per-method request/response contract coverage, mirroring every other RPC_CONTRACT cluster
  // above. sub.create's request is SubscriptionSchema.omit({id}).strict() — id is server-stamped,
  // so a caller-supplied id is an unknown field; once/wake carry static defaults.
  describe("sub.create", () => {
    const { request, response } = RPC_CONTRACT["sub.create"];
    it("request: accepts a minimal spec, applying once/wake defaults", () => {
      expect(request.parse({ subscriberId: "agent-1", topic: "task.state" }))
        .toEqual({ subscriberId: "agent-1", topic: "task.state", once: true, wake: "deliver" });
    });
    it("request: rejects a missing subscriberId", () => {
      expect(() => request.parse({ topic: "task.state" })).toThrow();
    });
    it("request: rejects a topic outside the TopicSchema enum", () => {
      expect(() => request.parse({ subscriberId: "agent-1", topic: "bogus.topic" })).toThrow();
    });
    it("request: rejects a caller-supplied id (omitted + strict — id is server-stamped)", () => {
      expect(() => request.parse({ id: "s1", subscriberId: "agent-1", topic: "task.state" })).toThrow();
    });
    it("request: carries filter/once/expiresAt/coalesceMs/wake/note through", () => {
      const parsed = request.parse({
        subscriberId: "agent-1", topic: "gate.verdict", filter: { agentId: ["a", "b"] },
        once: false, expiresAt: 10, coalesceMs: 0, wake: "resume", note: "hold",
      });
      expect(parsed).toMatchObject({ once: false, wake: "resume", expiresAt: 10, coalesceMs: 0, note: "hold", filter: { agentId: ["a", "b"] } });
    });
    it("response: round-trips a full Subscription (with the server-stamped id)", () => {
      const sub = { id: "sub-1", subscriberId: "agent-1", topic: "task.state", once: true, wake: "deliver" };
      expect(response.parse(sub)).toEqual(sub);
    });
    it("response: rejects a shape missing the required id", () => {
      expect(() => response.parse({ subscriberId: "agent-1", topic: "task.state", once: true, wake: "deliver" })).toThrow();
    });
    // F46/QA finding C: treeId/team are accepted by TopicFilterSchema but no projector ever
    // emits either — scopeFilterIssue rejects them here too (mirrors HookRuleSchema's check).
    it("request: rejects a filter on treeId (unsatisfiable — no projector ever emits it)", () => {
      expect(() => request.parse({ subscriberId: "agent-1", topic: "task.state", filter: { treeId: "t1" } })).toThrow();
    });
    it("request: rejects a filter on team (unsatisfiable — no projector ever emits it)", () => {
      expect(() => request.parse({ subscriberId: "agent-1", topic: "task.state", filter: { team: "sre" } })).toThrow();
    });
  });

  describe("sub.remove", () => {
    const { request, response } = RPC_CONTRACT["sub.remove"];
    it("request: requires subscriberId + id, strict", () => {
      expect(() => request.parse({ subscriberId: "agent-1" })).toThrow();   // id missing
      expect(() => request.parse({ id: "sub-1" })).toThrow();               // subscriberId missing
      expect(request.parse({ subscriberId: "agent-1", id: "sub-1" })).toEqual({ subscriberId: "agent-1", id: "sub-1" });
      expect(() => request.parse({ subscriberId: "agent-1", id: "sub-1", bogus: 1 })).toThrow();
    });
    it("response: { removed: boolean }", () => {
      expect(response.parse({ removed: true })).toEqual({ removed: true });
      expect(() => response.parse({ removed: "yes" })).toThrow();
    });
  });

  describe("sub.list", () => {
    const { request, response } = RPC_CONTRACT["sub.list"];
    it("request: requires subscriberId, strict", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ subscriberId: "agent-1" })).toEqual({ subscriberId: "agent-1" });
      expect(() => request.parse({ subscriberId: "agent-1", extra: 1 })).toThrow();
    });
    it("response: an array of Subscription", () => {
      const sub = { id: "sub-1", subscriberId: "agent-1", topic: "queue.drained", once: false, wake: "drop" };
      expect(response.parse([sub])).toEqual([sub]);
    });
  });

  // ---------- voice.* (VOICE S2, docs/superpowers/specs/2026-07-24-voice-agents-design.md §6) ----------
  describe("voice.session.start", () => {
    const { request, response } = RPC_CONTRACT["voice.session.start"];
    it("request: requires agentId, strict", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ agentId: "a1" })).toEqual({ agentId: "a1" });
      expect(() => request.parse({ agentId: "a1", bogus: 1 })).toThrow();
    });
    it("response: round-trips a VoiceSessionRecord", () => {
      const rec = { sessionId: "s1", agentId: "a1", state: "listening", startedAt: 0 };
      expect(response.parse(rec)).toEqual(rec);
    });
    it("response: rejects a state outside the enum and a missing field", () => {
      expect(() => response.parse({ sessionId: "s1", agentId: "a1", state: "bogus", startedAt: 0 })).toThrow();
      expect(() => response.parse({ sessionId: "s1", agentId: "a1", state: "listening" })).toThrow();
    });
  });

  describe("voice.session.stop", () => {
    const { request, response } = RPC_CONTRACT["voice.session.stop"];
    it("request: requires sessionId, strict", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ sessionId: "s1" })).toEqual({ sessionId: "s1" });
      expect(() => request.parse({ sessionId: "s1", bogus: 1 })).toThrow();
    });
    it("response: { stopped: boolean }", () => {
      expect(response.parse({ stopped: true })).toEqual({ stopped: true });
      expect(() => response.parse({ stopped: "yes" })).toThrow();
    });
  });

  describe("voice.conversation.set", () => {
    const { request, response } = RPC_CONTRACT["voice.conversation.set"];
    it("request: requires agentId + enabled, strict", () => {
      expect(() => request.parse({ agentId: "a1" })).toThrow();       // enabled missing
      expect(() => request.parse({ enabled: true })).toThrow();       // agentId missing
      expect(request.parse({ agentId: "a1", enabled: true })).toEqual({ agentId: "a1", enabled: true });
      expect(() => request.parse({ agentId: "a1", enabled: true, bogus: 1 })).toThrow();
    });
    it("response: echoes agentId + enabled", () => {
      expect(response.parse({ agentId: "a1", enabled: false })).toEqual({ agentId: "a1", enabled: false });
    });
  });

  describe("voice.room.reviewUpdate", () => {
    const { request, response } = RPC_CONTRACT["voice.room.reviewUpdate"];
    const roomId = "11111111-1111-4111-8111-111111111111";
    const hostId = "22222222-2222-4222-8222-222222222222";

    it("request: requires a room lease, integer revision and boolean decision, strict", () => {
      const params = { roomId, hostId, revision: 2, accept: true };
      expect(request.parse(params)).toEqual(params);
      expect(() => request.parse({ roomId, hostId, revision: 2 })).toThrow();
      expect(() => request.parse({ roomId, hostId, revision: 2.5, accept: true })).toThrow();
      expect(() => request.parse({ ...params, bogus: 1 })).toThrow();
    });

    it("response: validates the reviewed VoiceRoom including its pending proposal", () => {
      const room = {
        name: "Architecture review", agenda: "Review the proposed roster", agentIds: ["agent-1"],
        durationMinutes: 15, maxUtterances: 60, id: roomId, revision: 2, ownerAgentId: null,
        state: "active", createdAt: 1, expiresAt: 901_000, reason: null, participants: [],
        pendingUpdate: {
          name: "Architecture review", agenda: "Review the proposed roster", agentIds: ["agent-1", "agent-2"],
          durationMinutes: 20, maxUtterances: 80,
        },
      };
      expect(response.parse(room)).toEqual(room);
      expect(() => response.parse({ ...room, state: "reviewing" })).toThrow();
    });
  });

  describe("voice.room.report", () => {
    const { request, response } = RPC_CONTRACT["voice.room.report"];
    const roomId = "11111111-1111-4111-8111-111111111111";
    const hostId = "22222222-2222-4222-8222-222222222222";

    it("request: accepts only bounded diagnostic metadata for a valid room lease", () => {
      const params = {
        roomId, hostId,
        diagnostic: { source: "webrtc", event: "connection-state", agentId: "agent-1", connectionState: "connected" },
      };
      expect(request.parse(params)).toEqual(params);
      expect(() => request.parse({ ...params, diagnostic: { source: "audio", event: "connection-state" } })).toThrow();
      expect(() => request.parse({ ...params, diagnostic: { ...params.diagnostic, transcript: "private content" } })).toThrow();
      expect(() => request.parse({ ...params, bogus: 1 })).toThrow();
    });

    it("response: requires a strict recorded boolean acknowledgement", () => {
      expect(response.parse({ recorded: true })).toEqual({ recorded: true });
      expect(() => response.parse({ recorded: "yes" })).toThrow();
      expect(() => response.parse({ recorded: true, count: 1 })).toThrow();
    });
  });

  // ---------- voice.realtime.token (VOICE R1, docs/superpowers/specs/2026-07-24-voice-realtime-design.md §7/§9) ----------
  describe("voice.realtime.token", () => {
    const { request, response } = RPC_CONTRACT["voice.realtime.token"];
    it("request: requires mode, accountName/model optional, strict", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ mode: "transcription" })).toEqual({ mode: "transcription" });
      expect(request.parse({ mode: "s2s", accountName: "openai-voice", model: "gpt-realtime" }))
        .toEqual({ mode: "s2s", accountName: "openai-voice", model: "gpt-realtime" });
      expect(() => request.parse({ mode: "bogus" })).toThrow();
      expect(() => request.parse({ mode: "transcription", bogus: 1 })).toThrow();
    });
    it("response: round-trips { token, expiresAt, url, model }, strict", () => {
      const res = { token: "ek_abc", expiresAt: 1_700_000_000, url: "https://api.openai.com/v1/realtime", model: "gpt-realtime-whisper" };
      expect(response.parse(res)).toEqual(res);
      expect(() => response.parse({ ...res, bogus: 1 })).toThrow();
      expect(() => response.parse({ ...res, token: "" })).toThrow();
      expect(() => response.parse({ ...res, expiresAt: -1 })).toThrow();
    });
  });

  // ---------- mcpstore.oauth.start / mcpstore.oauth.finish (MCP-OAUTH slice 1) ----------
  describe("mcpstore.oauth.start", () => {
    const { request, response } = RPC_CONTRACT["mcpstore.oauth.start"];
    it("request: requires a valid mcpstore name, strict", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ name: "gateway" })).toEqual({ name: "gateway" });
      expect(() => request.parse({ name: "Gateway" })).toThrow();   // McpStoreNameSchema: lowercase only
      expect(() => request.parse({ name: "gateway", bogus: 1 })).toThrow();
    });
    it("response: round-trips { pendingId, authorizeUrl }, strict", () => {
      const res = { pendingId: "p1", authorizeUrl: "https://gateway.example.com/authorize?..." };
      expect(response.parse(res)).toEqual(res);
      expect(() => response.parse({ ...res, bogus: 1 })).toThrow();
      expect(() => response.parse({ pendingId: "p1" })).toThrow();   // authorizeUrl required
    });
  });

  describe("mcpstore.oauth.finish", () => {
    const { request, response } = RPC_CONTRACT["mcpstore.oauth.finish"];
    it("request: requires pendingId, strict", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ pendingId: "p1" })).toEqual({ pendingId: "p1" });
      expect(() => request.parse({ pendingId: "p1", bogus: 1 })).toThrow();
    });
    it("response: round-trips each status variant, strict", () => {
      expect(response.parse({ status: "pending" })).toEqual({ status: "pending" });
      expect(response.parse({ status: "connected" })).toEqual({ status: "connected" });
      expect(response.parse({ status: "error", error: "expired" })).toEqual({ status: "error", error: "expired" });
      expect(() => response.parse({ status: "bogus" })).toThrow();
      expect(() => response.parse({ status: "pending", bogus: 1 })).toThrow();
    });
  });

  // ---------- mcpstore.oauth.cancel (MCPSTORE-OAUTH-CANCEL) ----------
  describe("mcpstore.oauth.cancel", () => {
    const { request, response } = RPC_CONTRACT["mcpstore.oauth.cancel"];
    it("request: requires pendingId, strict", () => {
      expect(() => request.parse({})).toThrow();
      expect(request.parse({ pendingId: "p1" })).toEqual({ pendingId: "p1" });
      expect(() => request.parse({ pendingId: "p1", bogus: 1 })).toThrow();
    });
    it("response: empty object, strict", () => {
      expect(response.parse({})).toEqual({});
      expect(() => response.parse({ bogus: 1 })).toThrow();
    });
  });
});

describe("TYPED-CLIENT-SDK: buildFamilyClient", () => {
  it("groups every RPC_CONTRACT method under its '.' prefix, matching RPC_CONTRACT's own membership", () => {
    const spy = vi.fn(async () => ({}));
    const family = buildFamilyClient(spy as never);
    const families = new Set(ALL_METHODS.map((m) => m.split(".")[0]));
    expect(Object.keys(family).sort()).toEqual([...families].sort());
    for (const method of ALL_METHODS) {
      const dot = method.indexOf(".");
      const fam = method.slice(0, dot), leaf = method.slice(dot + 1);
      expect(typeof (family as Record<string, Record<string, unknown>>)[fam]?.[leaf]).toBe("function");
    }
  });

  it("a leaf function forwards (method, params, opts) to the injected call, unmodified", async () => {
    const spy = vi.fn(async (method: string, params: unknown, opts?: unknown) => ({ method, params, opts }));
    const family = buildFamilyClient(spy as never);
    const result = await family.queue.push({ queue: "q", prompt: "hi" }, { validateResponse: true });
    expect(spy).toHaveBeenCalledWith("queue.push", { queue: "q", prompt: "hi" }, { validateResponse: true });
    expect(result).toEqual({ method: "queue.push", params: { queue: "q", prompt: "hi" }, opts: { validateResponse: true } });
  });

  it("a leaf function called with no opts forwards opts as undefined", async () => {
    const spy = vi.fn(async () => ({}));
    const family = buildFamilyClient(spy as never);
    await family.team.dissolve({ name: "crew" });
    expect(spy).toHaveBeenCalledWith("team.dissolve", { name: "crew" }, undefined);
  });
});

describe("TYPED-CLIENT-SDK: validateRpcResponse", () => {
  it("a valid response round-trips unchanged", () => {
    const rec = { deleted: true };
    expect(validateRpcResponse("queue.delete", rec)).toEqual(rec);
  });

  it("an invalid response (missing a required field) throws a {code:'protocol'} error naming the method", () => {
    expect(() => validateRpcResponse("queue.status", { spec: { name: "q" } }))
      .toThrowError(/response validation failed for "queue.status"/);
    try {
      validateRpcResponse("queue.status", { spec: { name: "q" } });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: "protocol" });
    }
  });
});


describe("meeting participation planning contract", () => {
  it("bounds context and excludes arbitrary output fields", () => {
    const input = { requestId: "33333333-3333-4333-8333-333333333333", roomId: "11111111-1111-4111-8111-111111111111", hostId: "22222222-2222-4222-8222-222222222222", revision: 1, input: { topic: "Discuss", stage: "initial", candidates: ["a"], spoken: [], history: [] } };
    const c = RPC_CONTRACT["voice.room.plan"];
    expect(c.request.safeParse(input).success).toBe(true);
    expect(c.request.safeParse({ ...input, input: { ...input.input, history: Array(25).fill({ speaker: "a", text: "x" }) } }).success).toBe(false);
    expect(c.request.safeParse({ ...input, input: { ...input.input, spoken: Array(9).fill("a") } }).success).toBe(false);
    const answer = { action: "wait", agentId: null, discussion: false, topic: "Topic", contribution: "", reason: "No new contribution" };
    expect(c.response.safeParse(answer).success).toBe(true);
    expect(c.response.safeParse({ ...answer, action: "speak" }).success).toBe(false);
    expect(c.response.safeParse({ ...answer, tool: "exec" }).success).toBe(false);
  });
});
