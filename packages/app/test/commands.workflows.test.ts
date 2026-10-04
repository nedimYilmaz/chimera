import { describe, expect, it } from "vitest";
import type { UiStore } from "@chimera/ui-state";
import { createWorkflowsCommands, createWorkflowsLocal, resolveWorkflowNavigation } from "../src/state/commands.workflows";

// W18 (F16 task workflows, coverage B20/C14) — the workflow.* command
// wrappers. Mirrors commands.notify.test.ts/commands.usage.test.ts's harness
// (a stub RequestFn + a stub UiStore, no bridge.ts import) — createWorkflowsLocal
// gives each test its own local store instead of reaching for the app-wide
// `workflowsLocal` singleton.

type Call = { method: string; params: unknown };

function harness(listFor: () => Array<Record<string, unknown>>) {
  const calls: Call[] = [];
  const dispatched: unknown[] = [];
  const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
  const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === "workflow.list") return Promise.resolve(listFor() as unknown as T);
    if (method === "workflow.create") return Promise.resolve(undefined as unknown as T);
    if (method === "workflow.update") return Promise.resolve(undefined as unknown as T);
    if (method === "workflow.delete") return Promise.resolve(undefined as unknown as T);
    if (method === "queue.update") return Promise.resolve(undefined as unknown as T);
    return Promise.reject(new Error(`unexpected method ${method}`));
  };
  const local = createWorkflowsLocal();
  const cmds = createWorkflowsCommands(local, store, request);
  return { cmds, local, calls, dispatched };
}

const rec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "build",
  version: 1,
  onFail: "halt",
  retryLimit: 0,
  steps: [],
  createdAt: 1000,
  ...over,
});

describe("loadWorkflows / refresh", () => {
  it("shapes workflow.list rows into the local store", async () => {
    const h = harness(() => [rec()]);
    await h.cmds.loadWorkflows();
    expect(h.calls).toEqual([{ method: "workflow.list", params: {} }]);
    expect(h.local.getState().items.map((i) => i.name)).toEqual(["build"]);
  });

  it("refresh is the same operation as loadWorkflows", async () => {
    const h = harness(() => [rec({ name: "deploy" })]);
    await h.cmds.refresh();
    expect(h.local.getState().items.map((i) => i.name)).toEqual(["deploy"]);
  });

  it("a rejected workflow.list is caught (guarded) and toasts a commandError instead of throwing", async () => {
    const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
    const dispatched: unknown[] = [];
    const request = (): Promise<never> => Promise.reject(new Error("daemon down"));
    const local = createWorkflowsLocal();
    const cmds = createWorkflowsCommands(local, store, request as never);
    await expect(cmds.loadWorkflows()).resolves.toBeUndefined();
    expect(dispatched).toContainEqual({ type: "commandError", message: "daemon down" });
  });
});

describe("createWorkflow", () => {
  it("without bindToQueue: only workflow.create fires, then a relist", async () => {
    const h = harness(() => [rec()]);
    await h.cmds.createWorkflow({ name: "build", steps: [] });
    expect(h.calls.map((c) => c.method)).toEqual(["workflow.create", "workflow.list"]);
  });

  it("with bindToQueue: issues a SECOND rpc, queue.update{patch:{workflow:name}}, before relisting", async () => {
    const h = harness(() => [rec()]);
    await h.cmds.createWorkflow({ name: "build", steps: [] }, "main-queue");
    expect(h.calls.map((c) => c.method)).toEqual(["workflow.create", "queue.update", "workflow.list"]);
    const bind = h.calls.find((c) => c.method === "queue.update")!;
    expect(bind.params).toEqual({ name: "main-queue", patch: { workflow: "build" } });
  });

  it("REJECTS on a workflow.create failure (the form shows the error inline, not a toast)", async () => {
    const store = { dispatch: () => {} } as unknown as UiStore;
    const request = (): Promise<never> => Promise.reject(new Error("name taken"));
    const local = createWorkflowsLocal();
    const cmds = createWorkflowsCommands(local, store, request as never);
    await expect(cmds.createWorkflow({ name: "build", steps: [] })).rejects.toThrow("name taken");
  });
});

describe("updateWorkflow", () => {
  it("sends {name,patch}, then relists", async () => {
    const h = harness(() => [rec({ version: 2 })]);
    await h.cmds.updateWorkflow("build", { steps: [], onFail: "retry" });
    expect(h.calls[0]).toEqual({ method: "workflow.update", params: { name: "build", patch: { steps: [], onFail: "retry" } } });
    expect(h.calls[1]!.method).toBe("workflow.list");
    expect(h.local.getState().items[0]!.version).toBe(2);
  });

  it("REJECTS on failure (version-append contract: never silently swallowed)", async () => {
    const store = { dispatch: () => {} } as unknown as UiStore;
    const request = (): Promise<never> => Promise.reject(new Error("conflict"));
    const local = createWorkflowsLocal();
    const cmds = createWorkflowsCommands(local, store, request as never);
    await expect(cmds.updateWorkflow("build", { steps: [] })).rejects.toThrow("conflict");
  });
});

describe("resolveWorkflowNavigation (App.tsx's useNavigationSurfaces, {kind:\"workflow\"} deep link)", () => {
  it("resolves the matching workflow into a graph document, threading version + failedOnly", async () => {
    const request = <T,>(method: string): Promise<T> => {
      if (method === "workflow.list") return Promise.resolve([rec({ name: "release-flow", version: 4 }), rec({ name: "other" })] as unknown as T);
      return Promise.reject(new Error(`unexpected method ${method}`));
    };
    const result = await resolveWorkflowNavigation(request, { name: "release-flow", failedOnly: true });
    expect(result.version).toBe(4);
    expect(result.failedOnly).toBe(true);
    expect(result.document.name).toBe("release-flow");
  });

  it("defaults failedOnly to false when the target omits it", async () => {
    const request = <T,>(): Promise<T> => Promise.resolve([rec()] as unknown as T);
    const result = await resolveWorkflowNavigation(request, { name: "build" });
    expect(result.failedOnly).toBe(false);
  });

  it("rejects with a readable message when no workflow matches the name", async () => {
    const request = <T,>(): Promise<T> => Promise.resolve([rec({ name: "other" })] as unknown as T);
    await expect(resolveWorkflowNavigation(request, { name: "missing" })).rejects.toThrow("workflow not found: missing");
  });
});

describe("deleteWorkflow (guarded — reached only through the ConfirmCard gate)", () => {
  it("sends {name}, then relists", async () => {
    const h = harness(() => []);
    await h.cmds.deleteWorkflow("build");
    expect(h.calls.map((c) => c.method)).toEqual(["workflow.delete", "workflow.list"]);
  });

  it("a rejected workflow.delete is caught and toasts a commandError instead of throwing", async () => {
    const dispatched: unknown[] = [];
    const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
    const request = (): Promise<never> => Promise.reject(new Error("in use by a running task"));
    const local = createWorkflowsLocal();
    const cmds = createWorkflowsCommands(local, store, request as never);
    await expect(cmds.deleteWorkflow("build")).resolves.toBeUndefined();
    expect(dispatched).toContainEqual({ type: "commandError", message: "in use by a running task" });
  });
});
