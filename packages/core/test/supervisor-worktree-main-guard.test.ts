import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";

// engine-improve WORKTREE-MAIN-GUARD: the real, twice-observed failure was a
// worktree-isolated agent hand-rolling node_modules symlink setup (CLAUDE.md's
// documented workaround for a worktree having no node_modules) and, by mistake,
// repointing the MAIN checkout's packages/*/node_modules/@chimera/* symlinks at its
// OWN worktree — `tsc -b` in main then silently compiled another worktree's files
// under main's identity. This exercises the REAL decidePermission seam (via
// FakeAgentBackend's askPermission), not just the pure hosttools.ts parser, so it
// proves the wiring, not only the detection logic.

const bash = (command: string): FakeStep => ({ askPermission: { toolName: "Bash", input: { command } } });

const WORKTREE_FULL_AUTO = {
  prompt: "x", cwd: "/repo", account: "main", isolation: "worktree" as const,
  permissionProfile: "full" as const, on: { permissionRequest: "auto" as const },
};

describe("WORKTREE-MAIN-GUARD: decidePermission refuses a worktree agent's write into main's node_modules", () => {
  it("denies an ln that repoints main's @chimera symlink at the worktree — even under full+auto", async () => {
    const { sup, events } = makeSupervisor([[
      bash("ln -sfn /repo/.chimera/worktrees/task-1/packages/core /repo/packages/app/node_modules/@chimera/core"),
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ ...WORKTREE_FULL_AUTO, workdirKey: "task-1" });
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.some((e) => e.kind === "status" && e.data["denied"] === true)).toBe(true);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(0);
    const denied = tail.find((e) => e.kind === "policy_denied");
    expect(denied?.data).toMatchObject({ tool: "Bash", reason: "worktree_main_node_modules_write" });
    // no permission round-trip — this is an instant, unconditional deny (not "ask")
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(0);
  });

  it("denies a RELATIVE escape from inside the worktree back into main's node_modules", async () => {
    const { sup, events } = makeSupervisor([[
      bash("ln -sfn ../core ../../../node_modules/@chimera/core"),
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ ...WORKTREE_FULL_AUTO, workdirKey: "task-1" });
    await sup.waitFor(rec.agentId, 1000);
    expect(events.tail(rec.agentId, 50).some((e) => e.kind === "policy_denied")).toBe(true);
  });

  it("allows the SAME ln when isolation is \"none\" (guard is worktree-only)", async () => {
    const { sup, events } = makeSupervisor([[
      bash("ln -sfn /repo/packages/core /repo/packages/app/node_modules/@chimera/core"),
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ ...WORKTREE_FULL_AUTO, isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
  });

  it("allows an ordinary worktree Bash call untouched (byte-identical to no guard)", async () => {
    const { sup, events } = makeSupervisor([[bash("pnpm -w typecheck"), { end: { resultText: "done" } }]]);
    const rec = await sup.spawn({ ...WORKTREE_FULL_AUTO, workdirKey: "task-1" });
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
  });

  it("allows the sanctioned land-on-main git flow from a worktree agent", async () => {
    const { sup, events } = makeSupervisor([[
      bash("git -C /repo merge --no-ff chimera/task-1"),
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ ...WORKTREE_FULL_AUTO, workdirKey: "task-1" });
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
  });
});

// engine-improve WORKTREE-AGENT-WRITES-REACH-MAIN: the Edit-family generalization. Real,
// confirmed incident (not hypothesized): a worktree-isolated agent's own Edit-tool writes,
// intended for its worktree's packages/core/src/supervisor.ts, ALSO landed — uncommitted and
// duplicated — at the same relative path inside the MAIN checkout. findMainNodeModulesWrite
// only ever inspects a Bash argv, so it never saw this; this exercises the NEW Edit-family
// check through the SAME real decidePermission seam (via FakeAgentBackend's askPermission).
const edit = (file_path: string): FakeStep => ({ askPermission: { toolName: "Edit", input: { file_path } } });
const write = (file_path: string): FakeStep => ({ askPermission: { toolName: "Write", input: { file_path } } });

describe("WORKTREE-AGENT-WRITES-REACH-MAIN: decidePermission refuses a worktree agent's Edit/Write into main's source tree", () => {
  it("denies an Edit whose file_path is an absolute path rooted at main, not the worktree — even under full+auto", async () => {
    const { sup, events } = makeSupervisor([[
      edit("/repo/packages/core/src/supervisor.ts"),
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ ...WORKTREE_FULL_AUTO, workdirKey: "task-1" });
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.some((e) => e.kind === "status" && e.data["denied"] === true)).toBe(true);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(0);
    const denied = tail.find((e) => e.kind === "policy_denied");
    expect(denied?.data).toMatchObject({
      tool: "Edit", reason: "worktree_main_source_write", target: "/repo/packages/core/src/supervisor.ts",
    });
    // no permission round-trip — this is an instant, unconditional deny (not "ask")
    expect(tail.filter((e) => e.kind === "permission_request")).toHaveLength(0);
  });

  it("denies a Write into main's source tree the same way", async () => {
    const { sup, events } = makeSupervisor([[
      write("/repo/packages/core/src/new-file.ts"),
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ ...WORKTREE_FULL_AUTO, workdirKey: "task-1" });
    await sup.waitFor(rec.agentId, 1000);
    const denied = events.tail(rec.agentId, 50).find((e) => e.kind === "policy_denied");
    expect(denied?.data).toMatchObject({ tool: "Write", reason: "worktree_main_source_write" });
  });

  it("allows the IDENTICAL relative-path Edit when it targets the agent's OWN worktree", async () => {
    const { sup, events } = makeSupervisor([[
      edit("/repo/.chimera/worktrees/task-1/packages/core/src/supervisor.ts"),
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ ...WORKTREE_FULL_AUTO, workdirKey: "task-1" });
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
  });

  it("allows the SAME absolute main-path Edit when isolation is \"none\" (guard is worktree-only)", async () => {
    const { sup, events } = makeSupervisor([[
      edit("/repo/packages/core/src/supervisor.ts"),
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ ...WORKTREE_FULL_AUTO, isolation: "none" });
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
  });

  it("allows an ordinary worktree Edit untouched (byte-identical to no guard)", async () => {
    const { sup, events } = makeSupervisor([[
      edit("/repo/.chimera/worktrees/task-1/packages/core/src/whatever.ts"),
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ ...WORKTREE_FULL_AUTO, workdirKey: "task-1" });
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
  });

  it("still allows the sanctioned land-on-main git flow — this guard only touches Edit-family tools", async () => {
    const { sup, events } = makeSupervisor([[
      bash("git -C /repo merge --no-ff chimera/task-1"),
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ ...WORKTREE_FULL_AUTO, workdirKey: "task-1" });
    await sup.waitFor(rec.agentId, 1000);
    const tail = events.tail(rec.agentId, 50);
    expect(tail.filter((e) => e.kind === "tool_call")).toHaveLength(1);
    expect(tail.some((e) => e.kind === "policy_denied")).toBe(false);
  });
});
