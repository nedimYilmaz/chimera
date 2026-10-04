import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "@chimera/core/events";
import { QueueStore, TaskNotEditableError } from "@chimera/core/queues";

// TASK-EDIT-VERSIONING: a still-queued (pending/blocked) task is editable IN PLACE — prompt/role/
// priority/overrides/workflow binding — with an append-only version history, instead of the old
// cancel+re-push (which lost the taskId and dependsOn linkage). in_progress/terminal tasks are
// immutable. The next spawn (incl. a retry) reads the LIVE head fields.

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-qedit-"));
  const events = new EventLog(dir);
  return { dir, events, q: new QueueStore(dir, events) };
}

describe("QueueStore — editTask (TASK-EDIT-VERSIONING)", () => {
  it("edits a pending task's prompt in place, preserving identity + appending a version", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "old brief", role: "dev", priority: 3, pushedBy: "agent-x" });
    const createdAt = t.createdAt;

    const edited = q.editTask(t.taskId, { prompt: "new brief" }, "editor-1");

    // Live head is the new value; identity/provenance preserved.
    expect(edited.prompt).toBe("new brief");
    expect(edited.taskId).toBe(t.taskId);
    expect(edited.createdAt).toBe(createdAt);
    expect(edited.pushedBy).toBe("agent-x");
    expect(edited.state).toBe("pending");
    // One version entry recording exactly the changed field + its prior value.
    expect(edited.versions).toHaveLength(1);
    expect(edited.versions[0]).toMatchObject({
      version: 1, editedBy: "editor-1", changedFields: ["prompt"], prior: { prompt: "old brief" },
    });
    expect(typeof edited.versions[0]!.editedAt).toBe("number");
  });

  it("is a sparse patch: only provided AND actually-different fields change or version", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "brief", role: "dev", priority: 0, overrides: { model: "opus" } });

    // role + priority change; prompt re-sent identically (no-op for it); overrides untouched (absent).
    const edited = q.editTask(t.taskId, { prompt: "brief", role: "reviewer", priority: 5 }, null);
    expect(edited.role).toBe("reviewer");
    expect(edited.priority).toBe(5);
    expect(edited.prompt).toBe("brief");
    expect(edited.overrides).toEqual({ model: "opus" });   // untouched
    expect(edited.versions[0]!.changedFields.sort()).toEqual(["priority", "role"]);
    expect(edited.versions[0]!.prior).toEqual({ role: "dev", priority: 0 });
    expect(edited.versions[0]!.editedBy).toBeNull();
  });

  it("overrides edit uses structural equality — an equivalent object is NOT a change", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "b", overrides: { a: 1, nested: { x: [1, 2] } } });

    // Same content, different object identity + key order → no-op: returned unchanged, no version.
    const noop = q.editTask(t.taskId, { overrides: { nested: { x: [1, 2] }, a: 1 } }, null);
    expect(noop.versions).toHaveLength(0);
    expect(noop.overrides).toEqual({ a: 1, nested: { x: [1, 2] } });

    // A genuine change is recorded.
    const edited = q.editTask(t.taskId, { overrides: { a: 2 } }, null);
    expect(edited.overrides).toEqual({ a: 2 });
    expect(edited.versions).toHaveLength(1);
    expect(edited.versions[0]!.prior).toEqual({ overrides: { a: 1, nested: { x: [1, 2] } } });
  });

  it("maps the `workflow` patch field onto workflowOverride", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "b" });
    expect(t.workflowOverride).toBeNull();

    const edited = q.editTask(t.taskId, { workflow: "review-flow" }, null);
    expect(edited.workflowOverride).toBe("review-flow");
    expect(edited.versions[0]!.changedFields).toEqual(["workflowOverride"]);
    expect(edited.versions[0]!.prior).toEqual({ workflowOverride: null });
  });

  it("appends monotonically-versioned entries across multiple edits; head is latest", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "v0" });

    q.editTask(t.taskId, { prompt: "v1" }, "a");
    q.editTask(t.taskId, { prompt: "v2" }, "b");
    const head = q.editTask(t.taskId, { prompt: "v3" }, "c");

    expect(head.prompt).toBe("v3");
    expect(head.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    // Each entry stores the prior (pre-that-edit) value → unwind reconstructs history.
    expect(head.versions.map((v) => v.prior["prompt"])).toEqual(["v0", "v1", "v2"]);
  });

  it("edits a BLOCKED task; dependency gating is unchanged by the edit", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const a = q.push("work", { prompt: "first" });
    const b = q.push("work", { prompt: "second", dependsOn: [a.taskId] });
    expect(b.state).toBe("blocked");

    const edited = q.editTask(b.taskId, { prompt: "second, amended" }, "editor");
    expect(edited.state).toBe("blocked");            // still gated
    expect(edited.dependsOn).toEqual([a.taskId]);    // dependency preserved
    expect(q.nextPending("work")!.taskId).toBe(a.taskId);   // b still not eligible

    // Completing the dep still unblocks the (edited) task → its NEW prompt is what will spawn.
    q.markInProgress(a.taskId, "ag");
    q.markDone(a.taskId, "ok");
    const next = q.nextPending("work")!;
    expect(next.taskId).toBe(b.taskId);
    expect(next.prompt).toBe("second, amended");
  });

  it("retry interplay: a failed-and-reverted-to-pending task is editable; the retry uses the latest prompt", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 2 });
    const t = q.push("work", { prompt: "buggy brief" });

    // One failed attempt within the retry budget reverts the task to "pending" (no retryPolicy).
    q.markInProgress(t.taskId, "ag-1");
    const reverted = q.markFailedAttempt(t.taskId, 1, "boom");
    expect(reverted.state).toBe("pending");

    // "Fix the brief, let the retry use it": editing is now allowed and the next pickup sees it.
    const edited = q.editTask(t.taskId, { prompt: "fixed brief" }, "editor");
    expect(edited.state).toBe("pending");
    expect(edited.versions).toHaveLength(1);
    expect(q.nextPending("work")!.prompt).toBe("fixed brief");
  });

  it("rejects editing an in_progress or terminal task (immutable)", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "b" });

    q.markInProgress(t.taskId, "ag");
    expect(() => q.editTask(t.taskId, { prompt: "x" }, null)).toThrow(TaskNotEditableError);

    q.markDone(t.taskId, "done");
    expect(() => q.editTask(t.taskId, { prompt: "x" }, null)).toThrow(TaskNotEditableError);
  });

  it("preserves dependents pointing at the edited task (both directions of the link)", () => {
    const { q } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const a = q.push("work", { prompt: "dep" });
    const b = q.push("work", { prompt: "dependent", dependsOn: [a.taskId] });

    q.editTask(a.taskId, { prompt: "dep, amended" }, "editor");
    // b still points at a; a still exists with the same id.
    expect(q.getTask(b.taskId).dependsOn).toEqual([a.taskId]);
    expect(q.getTask(a.taskId).taskId).toBe(a.taskId);
  });

  it("emits a task_edited status event carrying version + changedFields", () => {
    const { q, events } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "b" });

    q.editTask(t.taskId, { prompt: "b2", priority: 9 }, "editor");
    const taskEvents = events.tail(`task:${t.taskId}`, 100);
    const edit = taskEvents.find((e) => (e.data as Record<string, unknown>)["edited"] === true);
    expect(edit).toBeTruthy();
    expect((edit!.data as Record<string, unknown>)["version"]).toBe(1);
    expect((edit!.data as Record<string, unknown>)["changedFields"]).toEqual(["prompt", "priority"]);
  });

  it("HOOK-1: an edit emits NO task_state_changed event — the task's state never changed (prevState undefined)", () => {
    // editTask calls emitTask WITHOUT a prevState (undefined), because an edit versions the task's
    // fields in place without a t.state transition. emitTask's `if (prevState === undefined) return`
    // must therefore suppress the task_state_changed (+ queue_drained) branch — only the
    // edited:true `status` event fires. Guards PLAN-HOOKS.md §5's "no state-change event for an
    // in-place edit" contract.
    const { q, events } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "b" });

    // Baseline: the push itself already emitted one task_state_changed (prevState null → pending).
    const changesBefore = events.tail(`task:${t.taskId}`, 100).filter((e) => e.kind === "task_state_changed");
    expect(changesBefore).toHaveLength(1);

    q.editTask(t.taskId, { prompt: "b2", priority: 9 }, "editor");

    // After the edit: still exactly one task_state_changed (the edit added none), and a fresh
    // edited:true status event exists.
    const changesAfter = events.tail(`task:${t.taskId}`, 100).filter((e) => e.kind === "task_state_changed");
    expect(changesAfter).toHaveLength(1);
    const editStatus = events.tail(`task:${t.taskId}`, 100).find((e) => (e.data as Record<string, unknown>)["edited"] === true);
    expect(editStatus).toBeTruthy();
  });

  it("HOOK-1: a no-op edit (nothing actually changed) emits neither a status nor a task_state_changed event", () => {
    // changedFields.length === 0 short-circuits before emitTask is ever called — no version, no
    // status event, and (transitively) no task_state_changed.
    const { q, events } = rig();
    q.create({ name: "work", retryLimit: 1 });
    const t = q.push("work", { prompt: "b" });
    const before = events.tail(`task:${t.taskId}`, 100);

    q.editTask(t.taskId, { prompt: "b" }, "editor");   // identical prompt → no-op

    const after = events.tail(`task:${t.taskId}`, 100);
    expect(after).toHaveLength(before.length);
    expect(after.some((e) => (e.data as Record<string, unknown>)["edited"] === true)).toBe(false);
  });
});
