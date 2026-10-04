import { describe, it, expect } from "vitest";
import type { FakeStep } from "@chimera/core/backends/fake";
import { makeSupervisor } from "./helpers.js";

// engine-improve BLOCKED-LANDING-NEEDS-A-DATA-FLAG: a cron sweep re-landed a branch TWICE
// after its agent was explicitly told no, because the only record of that refusal was the
// agent's own prose terminal report — a second LLM had to read and correctly interpret
// "I'm blocked" to notice. This proves the structured alternative: AgentRecord.landingPermissionDenied
// (and its agent.listSummary projection) is a plain boolean a sweep can check without
// interpreting anything.

const bash = (command: string): FakeStep => ({ askPermission: { toolName: "Bash", input: { command } } });

const SPEC = {
  prompt: "x", cwd: "/tmp", account: "main", isolation: "none" as const,
  on: { permissionRequest: "tui" as const },
};

describe("BLOCKED-LANDING-NEEDS-A-DATA-FLAG: landingPermissionDenied", () => {
  it("is set when a human denies a landing-class (git merge) permission request", async () => {
    const { sup, events } = makeSupervisor([[
      bash("git -C /repo merge --no-ff task-branch"),
      { end: { resultText: "I'm blocked, stopping." } },
    ]]);
    events.subscribe((e) => { if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), false); });
    const rec = await sup.spawn(SPEC);
    await sup.waitFor(rec.agentId, 1000);
    expect(sup.status(rec.agentId).landingPermissionDenied).toBe(true);
  });

  it("is set when a landing-class request times out unanswered (deny-by-default fallback)", async () => {
    const { sup } = makeSupervisor([[
      bash("git worktree remove /repo/.chimera/worktrees/task-1"),
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn(SPEC);
    await sup.waitFor(rec.agentId, 2000);
    expect(sup.status(rec.agentId).landingPermissionDenied).toBe(true);
  });

  it("is NOT set on a normal clean finish with no permission denial", async () => {
    const { sup } = makeSupervisor([[
      { end: { resultText: "done" } },
    ]]);
    const rec = await sup.spawn({ ...SPEC, on: { permissionRequest: "auto" } });
    await sup.waitFor(rec.agentId, 1000);
    expect(sup.status(rec.agentId).landingPermissionDenied).toBeUndefined();
  });

  it("is NOT set when a non-landing Bash permission request is denied", async () => {
    const { sup, events } = makeSupervisor([[
      bash("rm -rf /tmp/scratch"),
      { end: { resultText: "done" } },
    ]]);
    events.subscribe((e) => { if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), false); });
    const rec = await sup.spawn(SPEC);
    await sup.waitFor(rec.agentId, 1000);
    expect(sup.status(rec.agentId).landingPermissionDenied).toBeUndefined();
  });

  it("is NOT set when the landing-class request is APPROVED", async () => {
    const { sup, events } = makeSupervisor([[
      bash("git -C /repo merge --no-ff task-branch"),
      { end: { resultText: "landed" } },
    ]]);
    events.subscribe((e) => { if (e.kind === "permission_request") sup.respondPermission(String(e.data["requestId"]), true); });
    const rec = await sup.spawn(SPEC);
    await sup.waitFor(rec.agentId, 1000);
    expect(sup.status(rec.agentId).landingPermissionDenied).toBeUndefined();
  });
});
