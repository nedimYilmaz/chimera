import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkflowSpecSchema, WorkflowRecordSchema, type WorkflowSpec, type WorkflowRecord, type PlanArtifact, type WorkflowRunSpec, type WorkflowStep } from "@chimera/protocol";
import type { EventLog } from "./events.js";

export class UnknownWorkflowError extends Error { code = "protocol" as const; name = "UnknownWorkflowError"; }
export class DuplicateWorkflowError extends Error { code = "protocol" as const; name = "DuplicateWorkflowError"; }
// Nested sub-workflows: thrown by instantiateRecipe on a bad {recipeName, args} pairing —
// missing required param, wrong type, unknown arg key, or a step referencing an undeclared
// ${token}. Mirrors UnknownWorkflowError's `code`/`name` shape.
export class InvalidRecipeArgsError extends Error { code = "protocol" as const; name = "InvalidRecipeArgsError"; }

export type WorkflowUpdateInput = Partial<Omit<WorkflowSpec, "name">>;

// D12 (task workflows, coverage C14): ${home}/workflows.json. Mirrors QueueStore/
// JobScheduler's write-to-temp-then-rename persistence discipline. A workflow name is
// NEVER mutated in place — update() APPENDS a new version so a task that pinned an
// older version (QueueScheduler, at pickup) always resolves the exact steps it started
// with, even after the workflow is edited underneath it.
export class WorkflowStore {
  // name -> every version ever created, ascending (oldest first, latest last).
  private versions = new Map<string, WorkflowRecord[]>();
  private file: string;

  constructor(dir: string, private events: EventLog) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "workflows.json");
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as { workflows: unknown[] };
        for (const w of raw.workflows) {
          const r = WorkflowRecordSchema.parse(w);
          const list = this.versions.get(r.name) ?? [];
          list.push(r);
          this.versions.set(r.name, list);
        }
        for (const list of this.versions.values()) list.sort((a, b) => a.version - b.version);
      } catch (err) {
        // AUDIT-2 precedent (queues.json): operational state, not security-relevant —
        // quarantine a torn/corrupt file rather than crash-looping the daemon over it.
        this.versions.clear();
        const quarantined = `${this.file}.corrupt-${Date.now()}`;
        renameSync(this.file, quarantined);
        console.warn(`chimerad: corrupt coordination state in ${this.file}: ${(err as Error).message} — quarantined to ${quarantined}, booting with an empty workflow store`);
      }
    }
  }

  private save(): void {
    const all = [...this.versions.values()].flat();
    const tmp = `${this.file}.tmp`;   // write-to-temp-then-rename: no torn writes on power loss
    writeFileSync(tmp, JSON.stringify({ workflows: all }, null, 2));
    renameSync(tmp, this.file);
  }

  private emit(name: string, state: string, extra: Record<string, unknown> = {}): void {
    this.events.append({ agentId: `workflow:${name}`, kind: "status", data: { workflow: name, state, ...extra } });
  }

  create(input: unknown): WorkflowRecord {
    const spec = WorkflowSpecSchema.parse(input);
    if (this.versions.has(spec.name)) throw new DuplicateWorkflowError(`workflow "${spec.name}" already exists`);
    const record = WorkflowRecordSchema.parse({ ...spec, version: 1, createdAt: Date.now() });
    this.versions.set(spec.name, [record]);
    this.save();
    this.emit(spec.name, "created", { version: 1 });
    return record;
  }

  // The LATEST version by default; a specific pinned version for a bound task's gate
  // evaluation (QueueScheduler resolves against whatever {name, version} it pinned).
  get(name: string, version?: number): WorkflowRecord {
    const list = this.versions.get(name);
    if (!list || list.length === 0) throw new UnknownWorkflowError(`unknown workflow "${name}"`);
    if (version === undefined) return list[list.length - 1]!;
    const found = list.find((r) => r.version === version);
    if (!found) throw new UnknownWorkflowError(`workflow "${name}" has no version ${version}`);
    return found;
  }

  // Dynamic Planner: ephemeral (scheduler-synthesized) records never appear in the
  // authoring UI / workflow.list RPC — see instantiate() below. get() is unaffected (they
  // resolve by name exactly like any other WorkflowRecord).
  list(): WorkflowRecord[] { return [...this.versions.values()].map((l) => l[l.length - 1]!).filter((r) => !r.ephemeral); }

  // Dynamic Planner: compiles an agent-registered PlanArtifact into a fresh, persisted,
  // single-version WorkflowRecord that a nested child task binds to and runs under the
  // EXACT same gate/checkpoint/budget machinery as any hand-authored workflow. The name is
  // ALWAYS synthesized (never caller-supplied) — a plan is a one-off, never updated/
  // re-resolved by name from the authoring UI, so collision-avoidance (not readability) is
  // what matters. `ephemeral:true` is the only literal this method currently supports —
  // there's no non-ephemeral caller yet (see PLAN.md follow-ups).
  instantiate(spec: PlanArtifact, opts: { ephemeral: true; taskId: string; stepIndex: number }): WorkflowRecord {
    const name = `plan-${randomUUID()}`;
    const record = WorkflowRecordSchema.parse({
      name, steps: spec.steps, onFail: spec.onFail, retryLimit: spec.retryLimit,
      version: 1, createdAt: Date.now(), ephemeral: true,
    });
    this.versions.set(name, [record]);
    // restart-safety: the child task PINS {name, version} at pickup and must be able to
    // re-resolve it after a daemon restart, exactly like any other workflow.
    this.save();
    this.emit(name, "created", { version: 1, ephemeral: true, sourceTaskId: opts.taskId, sourceStepIndex: opts.stepIndex });
    return record;
  }

  // FEATURE WORKFLOW-RUN-P1: sibling of instantiate() above — compiles a caller-supplied,
  // already-graph-validated WorkflowRunSpec (workflow.run RPC, no source step/task — a
  // conductor dispatching an ad-hoc workflow directly, not a `plan` gate's compiled
  // artifact) into the SAME kind of fresh, persisted, single-version, ephemeral
  // WorkflowRecord. Kept separate from instantiate() rather than widening its opts (whose
  // {taskId, stepIndex} are meaningless here — this call has no source step) and its
  // PlanArtifact param type (which lacks retryPolicy). `run-` prefix keeps ephemeral names
  // visibly distinct from `plan-`/`recipe-*` at a glance (events, workflow:get diagnostics).
  instantiateAdHoc(spec: WorkflowRunSpec, opts: { sourceAgentId: string | null }): WorkflowRecord {
    const name = `run-${randomUUID()}`;
    const record = WorkflowRecordSchema.parse({
      name, steps: spec.steps, onFail: spec.onFail, retryLimit: spec.retryLimit, retryPolicy: spec.retryPolicy,
      version: 1, createdAt: Date.now(), ephemeral: true,
    });
    this.versions.set(name, [record]);
    // restart-safety: the child task PINS {name, version} at pickup and must be able to
    // re-resolve it after a daemon restart, exactly like any other workflow.
    this.save();
    this.emit(name, "created", { version: 1, ephemeral: true, sourceAgentId: opts.sourceAgentId });
    return record;
  }

  // Nested sub-workflows: resolves `recipeName`[/`version`] (this.get — throws
  // UnknownWorkflowError, same as any other lookup), binds `args` against its declared
  // `params` (missing required / wrong type / unknown key ⇒ InvalidRecipeArgsError), then
  // interpolates `${paramName}` tokens found ANYWHERE in the recipe's steps (JSON-round-trip:
  // stringify steps, regex-replace tokens with the JSON-escaped resolved value, reparse —
  // lets a param be referenced from any string field — title/instructions/gate spec
  // strings/etc — without hand-whitelisting which fields support templating). An unresolved
  // token (no matching declared param) throws InvalidRecipeArgsError rather than leaking a
  // literal "${x}" into a live agent's prompt. Persists via the SAME versions.set/save/emit
  // tail instantiate() (Dynamic Planner) uses above — kept as a small deliberate duplication
  // rather than refactoring that landed/tested method's internals (see PLAN.md).
  instantiateRecipe(
    recipeName: string,
    args: Record<string, string | number | boolean>,
    opts: { taskId: string; stepIndex: number; version?: number },
  ): WorkflowRecord {
    const recipe = this.get(recipeName, opts.version);
    const resolved: Record<string, string | number | boolean> = {};
    for (const p of recipe.params) {
      const value = args[p.name] ?? p.default;
      if (value === undefined) throw new InvalidRecipeArgsError(`recipe "${recipeName}" missing required param "${p.name}"`);
      if (typeof value !== p.type) throw new InvalidRecipeArgsError(`recipe "${recipeName}" param "${p.name}" expects ${p.type}, got ${typeof value}`);
      resolved[p.name] = value;
    }
    for (const key of Object.keys(args)) {
      if (!recipe.params.some((p) => p.name === key)) throw new InvalidRecipeArgsError(`recipe "${recipeName}" has no param "${key}"`);
    }
    let json = JSON.stringify(recipe.steps);
    json = json.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, tok: string) => {
      if (!(tok in resolved)) throw new InvalidRecipeArgsError(`recipe "${recipeName}" references unknown param "${tok}"`);
      return JSON.stringify(String(resolved[tok])).slice(1, -1);   // JSON-escaped, quotes stripped
    });
    const steps = JSON.parse(json) as WorkflowStep[];
    const name = `recipe-${recipeName}-${randomUUID()}`;
    const record = WorkflowRecordSchema.parse({
      name, steps, onFail: recipe.onFail, retryLimit: recipe.retryLimit, params: [],
      version: 1, createdAt: Date.now(), ephemeral: true,
    });
    this.versions.set(name, [record]);
    this.save();
    this.emit(name, "created", {
      version: 1, ephemeral: true, recipeName, recipeVersion: recipe.version,
      sourceTaskId: opts.taskId, sourceStepIndex: opts.stepIndex,
    });
    return record;
  }

  update(name: string, patch: WorkflowUpdateInput): WorkflowRecord {
    const current = this.get(name);   // latest — throws UnknownWorkflowError
    const merged = WorkflowSpecSchema.parse({
      name: current.name,
      steps: patch.steps ?? current.steps,
      onFail: patch.onFail ?? current.onFail,
      retryLimit: patch.retryLimit !== undefined ? patch.retryLimit : current.retryLimit,
      retryPolicy: patch.retryPolicy !== undefined ? patch.retryPolicy : current.retryPolicy,
      // Recipe templating: params merges the SAME "patch wins, else keep current" way as
      // every other field above — omitted from the patch, not a documented bug, this field
      // just didn't exist before subWorkflow/recipes.
      params: patch.params ?? current.params,
    });
    const record = WorkflowRecordSchema.parse({ ...merged, version: current.version + 1, createdAt: Date.now() });
    this.versions.get(name)!.push(record);
    this.save();
    this.emit(name, "updated", { version: record.version });
    return record;
  }

  // Idempotent: deleting an already-gone workflow returns false, not an error. Every
  // version is dropped. A task ALREADY BOUND (pinned {name, version}) that is still
  // walking its steps will fail its NEXT gate evaluation (QueueScheduler re-resolves the
  // pinned version on every turn, not just at pickup) — handled as a permanent task
  // failure there, not a crash. Accepted v1 tradeoff: deleting a workflow with live
  // bound tasks is the caller's call to make, same as deleting a queue with no
  // dependency-safety net beyond QueueStore's own non-empty guard.
  delete(name: string): boolean {
    if (!this.versions.has(name)) return false;
    this.versions.delete(name);
    this.save();
    this.emit(name, "deleted");
    return true;
  }
}
