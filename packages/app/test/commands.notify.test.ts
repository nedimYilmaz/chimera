import { describe, expect, it } from "vitest";
import type { UiStore } from "@chimera/ui-state";
import type { NotifyRule } from "@chimera/protocol";
import { applyNotifyDeepLink, createNotifyBridge, createNotifyCommands } from "../src/state/commands.notify";
import { jobsLocal } from "../src/state/commands.jobs";

// W20 gate (b), commands half: the rules-card CRUD store sends EXACTLY the
// config.patch shape the D14 overlay expects (the FULL array, merge-patch
// semantics — engine.ts's own doc comment), notify.test fires the bespoke RPC,
// and the app-wide bridge/deep-link routes a delivered event to the right
// store actions.

type Call = { method: string; params: unknown };

function harness(rules: () => NotifyRule[]) {
  const calls: Call[] = [];
  const dispatched: unknown[] = [];
  const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
  const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === "config.get") return Promise.resolve({ notify: rules() } as unknown as T);
    if (method === "config.patch") return Promise.resolve({ ok: true, changed: ["notify"] } as unknown as T);
    if (method === "notify.test") return Promise.resolve({ ok: true } as unknown as T);
    return Promise.reject(new Error(`unexpected method ${method}`));
  };
  const cmds = createNotifyCommands(store, request);
  return { cmds, calls, dispatched };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const rule = (over: Partial<NotifyRule> = {}): NotifyRule => ({
  name: "job-failed",
  on: { kind: "job_run_finished", filter: { result: "failed" } },
  channel: "toast",
  throttleSec: 60,
  enabled: true,
  ...over,
});

describe("toggle / refresh", () => {
  it("open fetches config.get and shapes the rows from .notify", async () => {
    const h = harness(() => [rule()]);
    h.cmds.toggle();
    await settle();
    expect(h.cmds.getState().open).toBe(true);
    expect(h.calls.filter((c) => c.method === "config.get")).toHaveLength(1);
    expect(h.cmds.rows()).toHaveLength(1);
    h.cmds.toggle();
    expect(h.cmds.getState().open).toBe(false);
  });
});

describe("space — toggleSelected", () => {
  it("flips enabled and writes the FULL rules array via config.patch", async () => {
    const h = harness(() => [rule({ enabled: true })]);
    h.cmds.toggle();
    await settle();
    await h.cmds.toggleSelected();
    const patch = h.calls.filter((c) => c.method === "config.patch");
    expect(patch).toHaveLength(1);
    expect((patch[0]!.params as { patch: { notify: NotifyRule[] } }).patch.notify).toEqual([rule({ enabled: false })]);
  });
});

describe("t — testSelected", () => {
  it("calls notify.test with the selected rule's name", async () => {
    const h = harness(() => [rule({ name: "peer-partitioned" })]);
    h.cmds.toggle();
    await settle();
    await h.cmds.testSelected();
    expect(h.calls).toContainEqual({ method: "notify.test", params: { rule: "peer-partitioned" } });
  });
});

describe("mod+o / submitForm — create", () => {
  it("rejects a blank name without writing anything", async () => {
    const h = harness(() => []);
    h.cmds.toggle();
    await settle();
    h.cmds.openNew();
    const ok = await h.cmds.submitForm();
    expect(ok).toBe(false);
    expect(h.cmds.getState().formError).toMatch(/name/);
    expect(h.calls.some((c) => c.method === "config.patch")).toBe(false);
  });
  it("rejects the webhook channel with no url", async () => {
    const h = harness(() => []);
    h.cmds.toggle();
    await settle();
    h.cmds.openNew();
    h.cmds.updateDraft({ name: "n1", kind: "job_run_finished", channel: "webhook" });
    const ok = await h.cmds.submitForm();
    expect(ok).toBe(false);
    expect(h.cmds.getState().formError).toMatch(/webhook/);
  });
  it("appends a valid new rule and closes the form", async () => {
    const h = harness(() => [rule()]);
    h.cmds.toggle();
    await settle();
    h.cmds.openNew();
    h.cmds.updateDraft({ name: "budget-alert", kind: "budget_warning", channel: "os", throttleSec: "30" });
    const ok = await h.cmds.submitForm();
    expect(ok).toBe(true);
    expect(h.cmds.getState().formOpen).toBe(false);
    const patch = h.calls.filter((c) => c.method === "config.patch");
    const written = (patch[0]!.params as { patch: { notify: NotifyRule[] } }).patch.notify;
    expect(written).toHaveLength(2);
    expect(written[1]).toEqual({ name: "budget-alert", on: { kind: "budget_warning" }, channel: "os", throttleSec: 30, enabled: true });
  });
  it("rejects a duplicate name against another rule", async () => {
    const h = harness(() => [rule({ name: "existing" })]);
    h.cmds.toggle();
    await settle();
    h.cmds.openNew();
    h.cmds.updateDraft({ name: "existing", kind: "job_run_finished" });
    const ok = await h.cmds.submitForm();
    expect(ok).toBe(false);
    expect(h.cmds.getState().formError).toMatch(/already exists/);
  });
});

describe("e / submitForm — edit (PREFILLED, rename-safe)", () => {
  it("prefills the draft from the selected rule and replaces it by ORIGINAL name on save", async () => {
    const h = harness(() => [rule({ name: "job-failed" })]);
    h.cmds.toggle();
    await settle();
    h.cmds.openEdit();
    expect(h.cmds.getState().editing).toBe("job-failed");
    expect(h.cmds.getState().draft.kind).toBe("job_run_finished");
    h.cmds.updateDraft({ name: "job-failed-renamed", throttleSec: "120" });
    const ok = await h.cmds.submitForm();
    expect(ok).toBe(true);
    const patch = h.calls.filter((c) => c.method === "config.patch");
    const written = (patch[0]!.params as { patch: { notify: NotifyRule[] } }).patch.notify;
    expect(written).toHaveLength(1); // replaced, not appended
    expect(written[0]!.name).toBe("job-failed-renamed");
    expect(written[0]!.throttleSec).toBe(120);
  });
});

describe("d — delete gate (⚠ ConfirmCard convention)", () => {
  it("requestDelete opens the confirm; confirmDelete writes the filtered array", async () => {
    const h = harness(() => [rule({ name: "a" }), rule({ name: "b" })]);
    h.cmds.toggle();
    await settle();
    h.cmds.select(0);
    h.cmds.requestDelete();
    expect(h.cmds.getState().confirmDelete).toBe("a");
    await h.cmds.confirmDelete();
    expect(h.cmds.getState().confirmDelete).toBeNull();
    const patch = h.calls.filter((c) => c.method === "config.patch");
    const written = (patch[0]!.params as { patch: { notify: NotifyRule[] } }).patch.notify;
    expect(written.map((r) => r.name)).toEqual(["b"]);
  });
  it("cancelDelete closes the gate without writing", () => {
    const h = harness(() => [rule()]);
    h.cmds.requestDelete();
    h.cmds.cancelDelete();
    expect(h.cmds.getState().confirmDelete).toBeNull();
    expect(h.calls.some((c) => c.method === "config.patch")).toBe(false);
  });
});

describe("esc tiering (form → confirm → card, HostToolsCard precedent)", () => {
  it("closes the form first, then the card", async () => {
    const h = harness(() => []);
    h.cmds.toggle();
    await settle();
    h.cmds.openNew();
    h.cmds.escape();
    expect(h.cmds.getState().formOpen).toBe(false);
    expect(h.cmds.getState().open).toBe(true);
    h.cmds.escape();
    expect(h.cmds.getState().open).toBe(false);
  });
});

describe("applyNotifyDeepLink (spec: click lands on the ⚠ card / the job row / the peers table)", () => {
  it("agents branch: selectAgent then selectTab", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
    const request = (): Promise<never> => Promise.reject(new Error("unexpected"));
    applyNotifyDeepLink({ tab: "agents", agentId: "a-1" }, store, request);
    expect(dispatched).toEqual([
      { type: "selectAgent", agentId: "a-1" },
      { type: "selectTab", tab: "agents" },
    ]);
  });

  it("settings branch: sets the network section and switches tabs", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
    const request = <T = unknown>(method: string): Promise<T> => {
      if (method === "accounts.list") return Promise.resolve([] as unknown as T);
      if (method === "config.get") return Promise.resolve({} as unknown as T);
      return Promise.reject(new Error(`unexpected ${method}`));
    };
    applyNotifyDeepLink({ tab: "settings", section: "network" }, store, request);
    expect(dispatched).toContainEqual({ type: "selectTab", tab: "settings" });
  });

  it("queues branch: loads jobs, cursors the schedules panel to the matching row, switches tabs", async () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
    const request = <T = unknown>(method: string): Promise<T> => {
      if (method === "job.list") return Promise.resolve([{ name: "other" }, { name: "nightly-build" }] as unknown as T);
      return Promise.reject(new Error(`unexpected ${method}`));
    };
    applyNotifyDeepLink({ tab: "queues", jobName: "nightly-build" }, store, request);
    await settle();
    expect(dispatched).toContainEqual({ type: "selectTab", tab: "queues" });
    expect(jobsLocal.getState().cursor).toBe(1);
    expect(jobsLocal.getState().focused).toBe(true);
  });
});

describe("createNotifyBridge (a delivered notify/notify_error event)", () => {
  it("a toast-channel delivery dispatches a notice", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
    const request = (): Promise<never> => Promise.reject(new Error("unexpected"));
    const bridge = createNotifyBridge(store, request);
    bridge.onDaemonEvent("notify", { ruleId: "job-failed", kind: "job_run_finished", channel: "toast", agentId: "job:nightly", count: 3 });
    expect(dispatched).toEqual([{ type: "notice", message: "job failed (×3)" }]);
  });
  it("an os-channel delivery does NOT toast (it's a Notification-API concern, guarded no-op under node)", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
    const request = (): Promise<never> => Promise.reject(new Error("unexpected"));
    const bridge = createNotifyBridge(store, request);
    bridge.onDaemonEvent("notify", { ruleId: "perm", kind: "permission_request", channel: "os", agentId: "a-1", count: 1 });
    expect(dispatched).toEqual([]);
  });
  it("notify_error surfaces as a commandError toast — never blocks", () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
    const request = (): Promise<never> => Promise.reject(new Error("unexpected"));
    const bridge = createNotifyBridge(store, request);
    bridge.onDaemonEvent("notify_error", { ruleId: "job-failed", channel: "webhook", message: "webhook responded 500" });
    expect(dispatched).toEqual([{ type: "commandError", message: 'notify: rule "job-failed" (webhook) — webhook responded 500' }]);
  });
});
