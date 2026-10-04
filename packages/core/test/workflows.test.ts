import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { EventLog } from "@chimera/core/events";
import { WorkflowStore, UnknownWorkflowError, DuplicateWorkflowError, InvalidRecipeArgsError } from "@chimera/core/workflows";

const NONE_STEP = { id: "s1", title: "step one", gate: { kind: "none" as const } };

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-wf-"));
  const events = new EventLog(dir);
  return { dir, events, store: new WorkflowStore(dir, events) };
}

describe("WorkflowStore (D12)", () => {
  it("create/list/get/delete lifecycle", () => {
    const { store } = makeStore();
    const created = store.create({ name: "review", steps: [NONE_STEP] });
    expect(created).toMatchObject({ name: "review", version: 1, onFail: "halt", retryLimit: 0 });

    expect(store.list().map((w) => w.name)).toEqual(["review"]);
    expect(store.get("review")).toEqual(created);
    expect(store.get("review", 1)).toEqual(created);

    expect(store.delete("review")).toBe(true);
    expect(store.delete("review")).toBe(false);   // idempotent
    expect(store.list()).toEqual([]);
  });

  it("rejects a duplicate name and an unknown lookup", () => {
    const { store } = makeStore();
    store.create({ name: "review", steps: [NONE_STEP] });
    expect(() => store.create({ name: "review", steps: [NONE_STEP] })).toThrow(DuplicateWorkflowError);
    expect(() => store.get("ghost")).toThrow(UnknownWorkflowError);
    expect(() => store.get("review", 99)).toThrow(UnknownWorkflowError);
  });

  it("update APPENDS a new version — list()/get() return latest, but an old version stays resolvable by number (pin safety)", () => {
    const { store } = makeStore();
    const v1 = store.create({ name: "review", steps: [NONE_STEP], retryLimit: 0 });
    const v2 = store.update("review", { retryLimit: 3 });
    expect(v2.version).toBe(2);
    expect(v2.retryLimit).toBe(3);

    expect(store.list().map((w) => w.version)).toEqual([2]);   // latest only
    expect(store.get("review")).toEqual(v2);
    expect(store.get("review", 1)).toEqual(v1);                // the OLD version is unchanged/still resolvable
    expect(store.get("review", 1).retryLimit).toBe(0);
  });

  it("persists across a reopen (restart-recovery precedent)", () => {
    const { dir, events } = makeStore();
    const store1 = new WorkflowStore(dir, events);
    store1.create({ name: "review", steps: [NONE_STEP] });
    store1.update("review", { onFail: "retry" });

    const store2 = new WorkflowStore(dir, events);   // simulates a daemon restart over the same home
    expect(store2.get("review").version).toBe(2);
    expect(store2.get("review").onFail).toBe("retry");
    expect(store2.get("review", 1).onFail).toBe("halt");
  });

  it("quarantines a corrupt workflows.json instead of crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "chimera-wf-corrupt-"));
    const events = new EventLog(dir);
    writeFileSync(join(dir, "workflows.json"), "{not json");
    const store = new WorkflowStore(dir, events);
    expect(store.list()).toEqual([]);
    const quarantined = readdirSync(dir).filter((f) => f.startsWith("workflows.json.corrupt-"));
    expect(quarantined.length).toBe(1);
  });
});

describe("WorkflowStore.instantiateRecipe (nested sub-workflows)", () => {
  const RECIPE_STEP = { id: "deploy", title: "deploy to ${env}", gate: { kind: "none" as const }, instructions: "target ${env}, replicas: ${count}" };
  const ENV_ONLY_STEP = { id: "deploy", title: "deploy to ${env}", gate: { kind: "none" as const } };

  it("interpolates ${param} tokens into a fresh ephemeral single-version record", () => {
    const { store } = makeStore();
    store.create({
      name: "deploy-recipe",
      params: [{ name: "env" }, { name: "count", type: "number" }],
      steps: [RECIPE_STEP],
    });
    const rec = store.instantiateRecipe("deploy-recipe", { env: "prod", count: 3 }, { taskId: "t1", stepIndex: 1 });
    expect(rec.name).toMatch(/^recipe-deploy-recipe-/);
    expect(rec.version).toBe(1);
    expect(rec.ephemeral).toBe(true);
    expect(rec.params).toEqual([]);
    expect(rec.steps[0]!.title).toBe("deploy to prod");
    expect(rec.steps[0]!.instructions).toBe("target prod, replicas: 3");
  });

  it("uses a param's declared default when args omits it", () => {
    const { store } = makeStore();
    store.create({ name: "with-default", params: [{ name: "env", default: "staging" }], steps: [ENV_ONLY_STEP] });
    const rec = store.instantiateRecipe("with-default", {}, { taskId: "t1", stepIndex: 1 });
    expect(rec.steps[0]!.title).toBe("deploy to staging");
  });

  it("throws InvalidRecipeArgsError for a missing required param", () => {
    const { store } = makeStore();
    store.create({ name: "requires-env", params: [{ name: "env" }], steps: [RECIPE_STEP] });
    expect(() => store.instantiateRecipe("requires-env", {}, { taskId: "t1", stepIndex: 1 })).toThrow(InvalidRecipeArgsError);
  });

  it("throws InvalidRecipeArgsError on a type mismatch", () => {
    const { store } = makeStore();
    store.create({ name: "typed", params: [{ name: "count", type: "number" }], steps: [NONE_STEP] });
    expect(() => store.instantiateRecipe("typed", { count: "3" }, { taskId: "t1", stepIndex: 1 })).toThrow(InvalidRecipeArgsError);
  });

  it("throws InvalidRecipeArgsError for an unknown arg key", () => {
    const { store } = makeStore();
    store.create({ name: "strict-args", params: [{ name: "env" }], steps: [RECIPE_STEP] });
    expect(() => store.instantiateRecipe("strict-args", { env: "prod", bogus: "x" }, { taskId: "t1", stepIndex: 1 })).toThrow(InvalidRecipeArgsError);
  });

  it("throws InvalidRecipeArgsError for an unresolved ${token} with no matching declared param", () => {
    const { store } = makeStore();
    store.create({ name: "no-params", params: [], steps: [RECIPE_STEP] });
    expect(() => store.instantiateRecipe("no-params", {}, { taskId: "t1", stepIndex: 1 })).toThrow(InvalidRecipeArgsError);
  });

  it("pins to an explicit version vs. resolving latest when omitted", () => {
    const { store } = makeStore();
    store.create({ name: "versioned", params: [{ name: "env", default: "v1-value" }], steps: [ENV_ONLY_STEP] });
    store.update("versioned", { params: [{ name: "env", default: "v2-value" }] });
    const pinned = store.instantiateRecipe("versioned", {}, { taskId: "t1", stepIndex: 1, version: 1 });
    expect(pinned.steps[0]!.title).toBe("deploy to v1-value");
    const latest = store.instantiateRecipe("versioned", {}, { taskId: "t1", stepIndex: 1 });
    expect(latest.steps[0]!.title).toBe("deploy to v2-value");
  });

  it("throws UnknownWorkflowError for an unknown recipe name", () => {
    const { store } = makeStore();
    expect(() => store.instantiateRecipe("ghost", {}, { taskId: "t1", stepIndex: 1 })).toThrow(UnknownWorkflowError);
  });
});
