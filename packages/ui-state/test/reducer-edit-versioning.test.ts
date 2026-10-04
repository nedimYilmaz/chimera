import { describe, it, expect } from "vitest";
import { reduce } from "@chimera/ui-state";
import { initialState, type EditTaskTarget } from "@chimera/ui-state";

// TASK-EDIT-VERSIONING: the two new reducer actions + the "editForm" mode that
// drive the queued-task edit form and the read-only version-history overlay.
describe("reducer: TASK-EDIT-VERSIONING", () => {
  it("defaults: editTask null, versionsOpen false", () => {
    expect(initialState.editTask).toBeNull();
    expect(initialState.versionsOpen).toBe(false);
  });

  it("editTask sets and clears the edit target (mirrors pushQueue)", () => {
    const target: EditTaskTarget = { taskId: "t1", queue: "q1", prompt: "do it", role: "dev", priority: "5" };
    const set = reduce(initialState, { type: "editTask", target });
    expect(set.editTask).toEqual(target);
    const cleared = reduce(set, { type: "editTask", target: null });
    expect(cleared.editTask).toBeNull();
  });

  it("versionsOpen toggles the overlay flag", () => {
    const open = reduce(initialState, { type: "versionsOpen", open: true });
    expect(open.versionsOpen).toBe(true);
    const closed = reduce(open, { type: "versionsOpen", open: false });
    expect(closed.versionsOpen).toBe(false);
  });

  it("setMode accepts the editForm mode", () => {
    const st = reduce(initialState, { type: "setMode", mode: "editForm" });
    expect(st.mode).toBe("editForm");
  });
});
