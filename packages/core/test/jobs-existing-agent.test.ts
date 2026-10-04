import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MailboxStore } from "@chimera/core/mailbox";
import { renderScheduledPrompt } from "@chimera/core/jobs";
import { makeJobRig, reopenJobs, openJobs } from "./jobs-helpers.js";

const start = Date.UTC(2026, 0, 1);
const spawn = { prompt: "existing work", cwd: "/tmp", isolation: "none", account: "main" } as const;
const spec = (agentId: string) => ({ name: "pinned", schedule: { every: { unit: "hours", n: 1 } }, target: { existingAgentId: agentId }, prompt: "Review the current changes." });

describe("scheduled prompts to existing agents", () => {
  it("persists snooze across reload, defers automatic runs, and permits manual override", async () => {
    const r = makeJobRig([[{ awaitSend: true }, { awaitSend: true }, { awaitSend: true }]], start);
    const agent = await r.sup.spawn(spawn);
    r.jobs.create(spec(agent.agentId));
    r.jobs.update("pinned", { snoozedUntil: start + 7200000 });
    const jobs = reopenJobs(r);
    r.clock.box.t += 3600000;
    await jobs.tick();
    expect(jobs.get("pinned").lastRuns).toHaveLength(0);
    expect(jobs.get("pinned").snoozedUntil).toBe(start + 7200000);
    expect((await jobs.runNow("pinned")).started).toBe(true);
    jobs.update("pinned", { snoozedUntil: null });
    expect(jobs.get("pinned").snoozedUntil).toBeNull();
    jobs.detach(); await r.sup.kill(agent.agentId);
  });

  it("refuses to wake and enqueue when the pending mailbox limit is reached", async () => {
    const r = makeJobRig([[{ awaitSend: true }]], start);
    const agent = await r.sup.spawn(spawn);
    await r.sup.hold(agent.agentId);
    await r.sup.send(agent.agentId, "already waiting");
    r.jobs.create({ ...spec(agent.agentId), target: { existingAgentId: agent.agentId, maxPendingMessages: 1 } });
    expect((await r.jobs.runNow("pinned")).started).toBe(false);
    expect(agent.state).toBe("paused");
    expect(r.jobs.get("pinned").lastRuns.at(-1)?.error).toContain("mailbox is full");
    expect(new MailboxStore(r.dir).history(agent.agentId).filter(m => m.from === "job:pinned")).toHaveLength(0);
    r.jobs.detach(); await r.sup.kill(agent.agentId);
  });

  it("renders only opted-in prompt variables, without evaluating expressions", () => {
    const job = { name: "j", target: { existingAgentId: "a" }, prompt: "{{job}} {{agentId}} {{iso}} {{ts}} {{process.env}}" };
    expect(renderScheduledPrompt(job, start)).toBe(job.prompt);
    expect(renderScheduledPrompt({ ...job, promptTemplate: true }, start)).toBe(`j a ${new Date(start).toISOString()} ${start} {{process.env}}`);
  });
  it("recovers an accepted message after a crash without sending it again", async () => {
    const r = makeJobRig([[{ awaitSend: true }, { awaitSend: true }]], start);
    const agent = await r.sup.spawn(spawn);
    r.jobs.create(spec(agent.agentId));
    const key = "job:pinned:manual-crash#0";
    await r.sup.sendScheduled(agent.agentId, "review", "job:pinned", "job:pinned:manual-crash:message");
    // A replay with the same receipt is also harmless after the target is killed.
    await r.sup.kill(agent.agentId);
    await r.sup.sendScheduled(agent.agentId, "review", "job:pinned", "job:pinned:manual-crash:message");
    r.jobs.detach();
    const file = join(r.dir, "jobs.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.jobs[0].inFlight = { kind: "message", agentId: agent.agentId, idempotencyKey: key, nominalFireTs: null, trigger: "manual", startedAt: start };
    writeFileSync(file, JSON.stringify(raw));
    const jobs = openJobs(r);
    expect(jobs.get("pinned").inFlight).toBeNull();
    expect(jobs.get("pinned").lastRuns.at(-1)).toMatchObject({ result: "ok", agentId: agent.agentId });
    expect(new MailboxStore(r.dir).history(agent.agentId)).toHaveLength(1);
    expect(r.fake.spawns).toHaveLength(1);
    jobs.detach();
  });
  it("delivers to the same agent, settles on acceptance, and permits repeated manual sends", async () => {
    const r = makeJobRig([[{ awaitSend: true }, { awaitSend: true }, { awaitSend: true }]], start);
    const agent = await r.sup.spawn(spawn);
    r.jobs.create(spec(agent.agentId));
    expect(await r.jobs.runNow("pinned")).toEqual({ started: true, agentId: agent.agentId });
    await r.jobs.runNow("pinned");
    expect(r.fake.spawns).toHaveLength(1);
    expect(agent.state).toBe("running");
    const job = r.jobs.get("pinned");
    expect(job.inFlight).toBeNull();
    expect(job.lastRuns).toHaveLength(2);
    expect(job.lastRuns[0]).toMatchObject({ result: "ok", agentId: agent.agentId, costUsd: 0 });
    expect(job.lastRuns[0]?.output).toContain("accepted");
    const mail = new MailboxStore(r.dir).history(agent.agentId);
    expect(mail.filter((m) => m.from === "job:pinned")).toHaveLength(2);
    expect(mail[0]?.text).toBe("Review the current changes.");
    r.jobs.detach(); await r.sup.kill(agent.agentId);
  });

  it("resumes a paused target under the same identity before delivering", async () => {
    const r = makeJobRig([[{ awaitSend: true }], [{ awaitSend: true }, { awaitSend: true }]], start);
    const agent = await r.sup.spawn(spawn);
    await r.sup.hold(agent.agentId);
    const sessionId = agent.sessionId;
    r.jobs.create(spec(agent.agentId));
    expect(await r.jobs.runNow("pinned")).toEqual({ started: true, agentId: agent.agentId });
    expect(agent.state).toBe("running");
    expect(r.fake.spawns[1]?.resume).toBe(sessionId ?? null);
    expect(r.jobs.get("pinned").lastRuns.at(-1)?.result).toBe("ok");
    expect(r.jobs.get("pinned").enabled).toBe(true);
    expect(new MailboxStore(r.dir).history(agent.agentId).filter(m => m.from === "job:pinned")).toHaveLength(1);
    expect(r.events.tail(agent.agentId, 100).some(e => e.kind === "status" && e.data["resumedBy"] === "scheduled-job")).toBe(true);
    r.jobs.detach(); await r.sup.kill(agent.agentId);
  });

  it("disables the job immediately when its pinned agent is killed", async () => {
    const r = makeJobRig([[{ awaitSend: true }]], start);
    const agent = await r.sup.spawn(spawn);
    r.jobs.create(spec(agent.agentId));
    await r.sup.kill(agent.agentId);
    expect(r.jobs.get("pinned")).toMatchObject({ enabled: false, nextRunTs: null });
    await r.jobs.runNow("pinned");
    expect(r.jobs.get("pinned").lastRuns.at(-1)?.result).toBe("failed");
    expect(agent.state).toBe("killed");
    expect(r.fake.spawns).toHaveLength(1);
    expect(new MailboxStore(r.dir).history(agent.agentId)).toHaveLength(0);
    r.jobs.detach();
  });

  it("does not deliver or rearm retries when kill wins during resume", async () => {
    const r = makeJobRig([[{ awaitSend: true }]], start);
    const agent = await r.sup.spawn(spawn);
    await r.sup.hold(agent.agentId);
    r.jobs.create(spec(agent.agentId));
    vi.spyOn(r.sup, "resumePaused").mockImplementation(async () => { await r.sup.kill(agent.agentId); });
    expect((await r.jobs.runNow("pinned")).started).toBe(false);
    expect(r.jobs.get("pinned")).toMatchObject({ enabled: false, nextRunTs: null });
    expect(r.jobs.get("pinned").failure?.retryAt).toBeNull();
    expect(new MailboxStore(r.dir).history(agent.agentId).filter(m => m.from === "job:pinned")).toHaveLength(0);
    expect(r.fake.spawns).toHaveLength(1);
    r.jobs.detach();
  });

  it("disables a job if the pinned identity disappeared", async () => {
    const r = makeJobRig([[{ awaitSend: true }]], start);
    const agent = await r.sup.spawn(spawn);
    r.jobs.create(spec(agent.agentId));
    const status = vi.spyOn(r.sup, "status").mockImplementation(() => { throw new Error("unknown agent"); });
    await r.jobs.runNow("pinned");
    expect(r.jobs.get("pinned")).toMatchObject({ enabled: false, nextRunTs: null });
    expect(r.jobs.get("pinned").disabledReason).toContain("missing");
    status.mockRestore();
    r.jobs.detach(); await r.sup.kill(agent.agentId);
  });

  it("rejects missing identities and a separate spawn budget", async () => {
    const r = makeJobRig([[{ awaitSend: true }]], start);
    expect(() => r.jobs.create(spec("missing"))).toThrow();
    const agent = await r.sup.spawn(spawn);
    expect(() => r.jobs.create({ ...spec(agent.agentId), maxBudgetUsd: 1 })).toThrow("own budget");
    r.jobs.detach(); await r.sup.kill(agent.agentId);
  });

  it("keeps the pin after reload and deduplicates a scheduled occurrence", async () => {
    const r = makeJobRig([[{ awaitSend: true }, { awaitSend: true }]], start);
    const agent = await r.sup.spawn(spawn);
    r.jobs.create(spec(agent.agentId));
    const jobs = reopenJobs(r);
    r.clock.box.t += 3_600_000;
    await jobs.tick(); await jobs.tick();
    expect(jobs.get("pinned").target).toEqual({ existingAgentId: agent.agentId });
    expect(new MailboxStore(r.dir).history(agent.agentId)).toHaveLength(1);
    jobs.detach(); await r.sup.kill(agent.agentId);
  });
});
