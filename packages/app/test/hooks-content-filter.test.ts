import { describe, expect, it, vi } from "vitest";
import { contentFilterIssue } from "@chimera/protocol";
import { createHooksCommands } from "../src/state/commands.hooks";
import type { UiStore } from "@chimera/ui-state";

// F46.UI (QA finding E). The daemon enforces BOTH directions of the content-topic contract
// (agent.output requires filter.contains; every other topic rejects it), but the hook form used
// to offer `contains` on every topic and surface the refusal only as a failed save. These are
// the store-seam guarantees behind that fix: the draft is reconciled when the topic changes,
// and an illegal draft never leaves the app.

const store = { getState: () => ({ hooks: {} }), dispatch: () => {} } as unknown as UiStore;

const rig = () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === "hook.list") return [];
    return { ok: true };
  });
  return { calls, cmds: createHooksCommands(store, request as never) };
};

const toastAction = {
  type: "channel" as const, to: "", text: "", queue: "", prompt: "", role: "",
  command: "", timeoutSec: "60", channel: "toast" as const, webhookUrl: "",
};

describe("hook form: the content-topic filter contract is enforced client-side", () => {
  it("selecting agent.output pre-selects contains and clears a now-illegal value", () => {
    const { cmds } = rig();
    cmds.openNew();
    cmds.updateDraft({ filterKey: "queue", filterValue: "work" });
    cmds.updateDraft({ topic: "agent.output" });
    expect(cmds.getState().draft.filterKey).toBe("contains");
    expect(cmds.getState().draft.filterValue).toBe("");
  });

  it("leaving a content topic drops contains instead of carrying a rejected key along", () => {
    const { cmds } = rig();
    cmds.openNew();
    cmds.updateDraft({ topic: "agent.output" });
    cmds.updateDraft({ filterValue: "panic:" });
    cmds.updateDraft({ topic: "task.state" });
    expect(cmds.getState().draft.filterKey).toBe("");
    expect(cmds.getState().draft.filterValue).toBe("");
  });

  it("an unfiltered agent.output rule fails inline with the daemon's own wording, and is never sent", async () => {
    const { calls, cmds } = rig();
    await cmds.refresh();
    cmds.openNew();
    cmds.updateDraft({ name: "watch", topic: "agent.output", filterKey: "", filterValue: "", actions: [toastAction] });
    expect(await cmds.submitForm()).toBe(false);
    expect(cmds.getState().formError).toBe(contentFilterIssue("agent.output", undefined));
    expect(calls.some((c) => c.method === "hook.create")).toBe(false);
  });

  it("a valid content rule still reaches hook.create with its needle intact", async () => {
    const { calls, cmds } = rig();
    await cmds.refresh();
    cmds.openNew();
    cmds.updateDraft({ name: "watch", topic: "agent.output", filterKey: "contains", filterValue: "panic:", actions: [toastAction] });
    expect(await cmds.submitForm()).toBe(true);
    expect(calls.find((c) => c.method === "hook.create")?.params)
      .toMatchObject({ rule: { on: "agent.output", filter: { contains: "panic:" } } });
  });
});
