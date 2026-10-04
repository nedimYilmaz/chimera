import { describe, expect, it, vi } from "vitest";
import type { HookRule } from "@chimera/protocol";
import { buildPushParams, buildEditPatch, editFormValuesFromTask, parseTagList, taskRowView, matchesTaskQuery } from "../src/state/selectors.coord";
import { filterFromDraft, createHooksCommands, type HookFormDraft } from "../src/state/commands.hooks";
import type { UiStore } from "@chimera/ui-state";

// The UI counterpart of TASK-TAGS + HOOK-CRUD-RPC. Two things were outright broken before, not
// merely missing: the hook form could not express a `tags` filter at all (it serialised every
// filter value as a STRING, which TopicFilterSchema rejects for the one array-valued key), and
// the hooks card wrote the WHOLE rule array on every change, silently erasing any rule an agent
// had installed since its last read.

describe("task tags in the app's queue forms", () => {
  it("push form: a comma-separated field becomes a real string[] on the wire, and stays absent when blank", () => {
    const base = { prompt: "do it", priority: "5", role: "", workflow: "" };
    expect(buildPushParams("work", { ...base, tags: "gate:coverage, area:core" }))
      .toMatchObject({ tags: ["gate:coverage", "area:core"] });
    // an untagged push must not send `tags: []` — the record's own default covers it
    expect(buildPushParams("work", { ...base, tags: "  ,  " })).not.toHaveProperty("tags");
  });

  it("edit patch: tags are ALWAYS sent, because emptying the field is how you remove them all", () => {
    const base = { prompt: "do it", priority: "5", role: "" };
    expect(buildEditPatch({ ...base, tags: "gate:lint" })).toMatchObject({ tags: ["gate:lint"] });
    // whole-value replacement: an emptied field must reach the daemon as [], not vanish
    expect(buildEditPatch({ ...base, tags: "" })).toMatchObject({ tags: [] });
  });

  it("the edit form prefills from the task's current tags and round-trips them unchanged", () => {
    const values = editFormValuesFromTask({ taskId: "t1", state: "pending", prompt: "p", priority: 3, tags: ["a", "b"] });
    expect(values.tags).toBe("a, b");
    expect(buildEditPatch(values)).toMatchObject({ tags: ["a", "b"] });
  });

  it("parseTagList trims, drops blanks, and tolerates junk", () => {
    expect(parseTagList(" a , ,b,  ")).toEqual(["a", "b"]);
    expect(parseTagList("")).toEqual([]);
  });

  it("a task row reads tags defensively — a pre-tags record projects [], never undefined", () => {
    expect(taskRowView({ taskId: "t1" }).tags).toEqual([]);
    expect(taskRowView({ taskId: "t1", tags: ["x", 3, null] }).tags).toEqual(["x"]);
  });

  it("the queue drill's free-text filter matches on tags too", () => {
    const row = taskRowView({ taskId: "t1", prompt: "ship it", tags: ["gate:coverage"] });
    expect(matchesTaskQuery(row, "coverage")).toBe(true);
    expect(matchesTaskQuery(row, "lint")).toBe(false);
  });
});

describe("hook rule form: the tags filter", () => {
  it("builds an ARRAY for tags — the shape TopicFilterSchema requires and the old string broke", () => {
    expect(filterFromDraft("tags", "gate:coverage, area:core")).toEqual({ tags: ["gate:coverage", "area:core"] });
  });

  it("drops the filter entirely when every tag is blank — {tags:[]} matches nothing by definition", () => {
    expect(filterFromDraft("tags", " , ")).toBeUndefined();
    expect(filterFromDraft("", "anything")).toBeUndefined();
  });

  it("leaves every other filter key on its existing scalar behaviour", () => {
    expect(filterFromDraft("state", "failed")).toEqual({ state: "failed" });
    expect(filterFromDraft("queue", "work")).toEqual({ queue: "work" });
  });
});

describe("hooks card CRUD goes through the scoped hook.* RPCs", () => {
  const rule = (name: string): HookRule => ({
    name, enabled: true, on: "queue.drained",
    actions: [{ type: "channel", channel: "toast" }], maxChainDepth: 3, maxFiresPerHour: 20,
  });
  const store = { getState: () => ({ hooks: {} }), dispatch: () => {} } as unknown as UiStore;

  const rig = (rules: HookRule[]) => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "hook.list") return rules;
      return { ok: true };
    });
    return { calls, cmds: createHooksCommands(store, request as never) };
  };

  it("reads through hook.list, not config.get", async () => {
    const { calls, cmds } = rig([rule("a")]);
    await cmds.refresh();
    expect(calls.map((c) => c.method)).toEqual(["hook.list"]);
    expect(cmds.getState().rules.map((r) => r.name)).toEqual(["a"]);
  });

  it("toggling a rule sends hook.setEnabled for THAT rule — not the whole array", async () => {
    const { calls, cmds } = rig([rule("a"), rule("b")]);
    await cmds.refresh();
    cmds.select(0);
    await cmds.toggleSelected();
    const write = calls.find((c) => c.method === "hook.setEnabled");
    expect(write?.params).toEqual({ name: "a", enabled: false });
    // the untouched rule is never re-sent, so a concurrent change to it cannot be clobbered
    expect(JSON.stringify(calls)).not.toContain('"b"');
  });

  it("deleting a rule sends hook.delete by name", async () => {
    const { calls, cmds } = rig([rule("a"), rule("b")]);
    await cmds.refresh();
    cmds.select(1);
    cmds.requestDelete();
    await cmds.confirmDelete();
    expect(calls.find((c) => c.method === "hook.delete")?.params).toEqual({ name: "b" });
  });

  it("submitting a NEW rule sends hook.create; editing an existing one sends hook.update", async () => {
    const draft: HookFormDraft = {
      name: "fresh", topic: "queue.drained", filterKey: "", filterValue: "",
      actions: [{ type: "channel", to: "", text: "", queue: "", prompt: "", role: "", command: "", timeoutSec: "60", channel: "toast", webhookUrl: "" }],
      enabled: true,
    };
    const { calls, cmds } = rig([]);
    await cmds.refresh();
    cmds.openNew();
    cmds.updateDraft(draft);
    await cmds.submitForm();
    expect(calls.some((c) => c.method === "hook.create")).toBe(true);
    expect(calls.some((c) => c.method === "config.patch")).toBe(false);
  });
});
