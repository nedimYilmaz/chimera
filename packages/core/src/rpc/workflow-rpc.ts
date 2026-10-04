// FEATURE-11: workflow.* RPC family (D12, task workflows), extracted verbatim out of
// engine.ts's old inline `switch` case bodies into its own ContractHandlers slice. Local-only
// by construction (absent from PEER_METHODS): a peer never sees or drives our workflow
// definitions — unchanged by this extraction, still enforced entirely by engine.ts's own
// isFederated routing ahead of the contract dispatch.
//
// FEATURE WORKFLOW-RUN-P1 widens this family's deps (queues/teams/projects/supervisor/
// scheduler/home, alongside the original workflows-only dep) to add workflow.run — the
// "design-and-run" ephemeral-workflow tool needs all of them to resolve/provision a queue,
// not just the workflow store.
import { randomUUID } from "node:crypto";
import type { ContractHandlers } from "@chimera/protocol/contract";
import type { WorkflowStep } from "@chimera/protocol";
import { rpcError } from "../rpc-error.js";
import type { WorkflowStore } from "../workflows.js";
import type { QueueStore } from "../queues.js";
import type { TeamManager } from "../teams.js";
import { isPathUnder, type ProjectStore } from "../projects.js";
import type { AgentSupervisor } from "../supervisor.js";
import type { QueueScheduler } from "../scheduler.js";

export type WorkflowRpcHandlers = Pick<ContractHandlers, "workflow.create" | "workflow.list" | "workflow.update" | "workflow.delete" | "workflow.run" | "workflow.plan">;

// FEATURE WORKFLOW-RUN-P2: the canned instructions for workflow.plan's synthesized "design"
// step — mirrors engine.ts's projectConductorInstructions (a plain function returning
// templated prompt text, colocated with the RPC logic that consumes it). States the
// PlanArtifact contract precisely (it's the exact payload PlanArtifactSchema in @chimera/
// protocol validates, minus the top-level `name` — see workflows.ts's instantiate()) so any
// model, not just ones that have seen this codebase, can emit a valid plan.
function plannerInstructions(goal: string): string {
  return `You are designing a workflow to achieve this goal: "${goal}"\n\n` +
    `Do not attempt the goal yourself. Instead, break it into a sequence of steps another ` +
    `agent (or several, in parallel) will execute, then register that plan as a structured ` +
    `artifact using the "artifact_add" tool with kind:"file" and label:"plan", pointing at a ` +
    `JSON file with this exact shape:\n` +
    `{"steps": [{"id": "unique-step-id", "title": "short title", "gate": {"kind": "none"}, ` +
    `"instructions": "optional extra instructions for this step's agent"}], ` +
    `"onFail": "halt", "retryLimit": 0}\n\n` +
    `Rules for "steps" (max 20):\n` +
    `- Each step needs a unique "id" and a "title". "instructions"/"role"/"model" are optional.\n` +
    `- "gate" decides how a step's completion is judged: {"kind":"none"} (no extra check), ` +
    `{"kind":"critic","spec":{"criteria":"..."}} (a separate agent judges the output against ` +
    `criteria and can send it back for revision), or {"kind":"artifact","spec":{}} (the step ` +
    `must register an artifact before it counts as done).\n` +
    `- By default steps run in order, one after another. Add "next":[{"to":"stepId"}] to a ` +
    `step ONLY when you need conditional routing instead of the plain default order.\n` +
    `- For parallel work, use "fanOut" on a step INSTEAD of "next": ` +
    `{"source":{"kind":"list","items":["a","b","c"]},"joinStep":"stepIdToResumeAt"} spawns one ` +
    `branch task per item, running concurrently, then resumes at "joinStep" once every branch ` +
    `finishes. A fan-out step itself runs no agent — omit it from steps[0].\n` +
    `- "onFail" is "halt" (default), "retry", or "remediate"; "retryLimit" bounds retries.\n\n` +
    `Once you've written the plan file and called artifact_add, your turn is done — the ` +
    `compiled plan runs automatically as a nested workflow and you do not need to do anything else.`;
}

export class WorkflowRpc {
  readonly handlers: WorkflowRpcHandlers;

  constructor(private readonly deps: {
    workflows: WorkflowStore; queues: QueueStore; teams: TeamManager; projects: ProjectStore;
    supervisor: AgentSupervisor; scheduler: QueueScheduler; home: string;
  }) {
    this.handlers = {
      "workflow.create": (p) => this.deps.workflows.create(p.spec),
      "workflow.list": () => this.deps.workflows.list(),
      "workflow.update": (p) => this.deps.workflows.update(p.name, p.patch),
      "workflow.delete": (p) => ({ deleted: this.deps.workflows.delete(p.name) }),
      // FEATURE WORKFLOW-RUN-P1: queue resolution runs BEFORE the ephemeral workflow is
      // compiled/persisted — an unresolvable queue (unknown explicit name, or no queue at
      // all with provision unset) must fail with NOTHING written, mirroring queue.create/
      // queue.push's existing "UnknownWorkflowError before anything persists" ordering.
      "workflow.run": async (p) => {
        const agentId = p.agentId ?? null;
        const queueName = await this.resolveQueue(agentId, p.queue, p.provision, "workflow_run");
        const record = this.deps.workflows.instantiateAdHoc(p.spec, { sourceAgentId: agentId });
        const task = this.deps.queues.push(queueName, {
          prompt: p.prompt, priority: p.priority, role: p.role ?? null,
          overrides: p.overrides, dependsOn: p.dependsOn, pushedBy: agentId,
          workflow: record.name,
        });
        await this.deps.scheduler.tick();
        return task;
      },
      // FEATURE WORKFLOW-RUN-P2: "plan-and-run" — reuses workflow.run's exact queue-
      // resolution/provision path (resolveQueue), then synthesizes a two-step ephemeral
      // workflow instead of taking caller-authored steps: step 0 ("design") is `plan`-gated
      // (the SAME Dynamic Planner gate a hand-authored workflow.create'd `plan` step gets —
      // scheduler.ts's evaluatePlanGate compiles whatever PlanArtifact the design step's
      // agent registers, beginPlanDispatch runs it as a nested child under full gate/
      // checkpoint/budget machinery), step 1 ("done") is where the parent resumes once that
      // child joins. No new compile path — instantiateAdHoc is the exact same call workflow.
      // run makes, just fed a synthesized spec instead of a caller-supplied one.
      "workflow.plan": async (p) => {
        const agentId = p.agentId ?? null;
        const queueName = await this.resolveQueue(agentId, p.queue, p.provision, "workflow_plan");
        const plannerOverrides = p.plannerOverrides ?? {};
        const steps: WorkflowStep[] = [
          {
            id: "design", title: "design workflow", context: "handoff",
            gate: { kind: "plan", spec: { resumeStep: "done", scope: "step" } },
            instructions: plannerInstructions(p.goal),
            ...(plannerOverrides.model ? { model: plannerOverrides.model } : {}),
          },
          {
            id: "done", title: "done", context: "handoff", gate: { kind: "none" },
            instructions: "The agent-designed workflow finished running. Summarize the outcome for the caller.",
          },
        ];
        const record = this.deps.workflows.instantiateAdHoc(
          { steps, onFail: "halt", retryLimit: 0 }, { sourceAgentId: agentId },
        );
        // account/permissionProfile have no per-step landing spot (unlike `model`, WorkflowStep
        // carries neither) — folded into the task-level overrides instead, same as `overrides`
        // below; harmless on the trivial "done" step since it shares the SAME task-level spawn.
        const overrides = {
          ...(p.overrides ?? {}),
          ...(plannerOverrides.account ? { account: plannerOverrides.account } : {}),
          ...(plannerOverrides.permissionProfile ? { permissionProfile: plannerOverrides.permissionProfile } : {}),
        };
        const task = this.deps.queues.push(queueName, {
          prompt: `Design and run a workflow to achieve: ${p.goal}`,
          priority: p.priority, role: p.role ?? null,
          overrides, pushedBy: agentId,
          workflow: record.name,
        });
        await this.deps.scheduler.tick();
        // plannedWorkflowName is deliberately omitted — see WorkflowPlanResponseSchema's
        // comment in @chimera/protocol/contract.
        return { taskId: task.taskId };
      },
    };
  }

  // FEATURE WORKFLOW-RUN-P1/P2: shared queue-resolution path for both design-and-run
  // entries — explicit `queue` wins (UnknownQueueError before anything persists), else the
  // caller's own project queue, else provision:true's scratch queue+team, else a protocol
  // error with nothing written.
  private async resolveQueue(
    agentId: string | null, explicitQueue: string | undefined, provision: boolean | undefined, toolName: string,
  ): Promise<string> {
    let queueName = explicitQueue ?? null;
    if (queueName) this.deps.queues.get(queueName);   // UnknownQueueError before anything persists
    else queueName = this.resolveCallerProjectQueue(agentId);
    if (!queueName) {
      if (!provision) {
        throw rpcError("protocol",
          `${toolName} has no queue to push to — pass "queue" explicitly, run it from an agent whose cwd is under a registered project with a bound queue, or pass provision:true to auto-create a scratch queue+team`);
      }
      queueName = await this.provisionScratch(agentId);
    }
    return queueName;
  }

  // The calling agent's PROJECT queue — same "cwd under a registered project's path" match
  // engine.ts's own `projectFor` seam uses for spawn-time projectId resolution. Returns null
  // (not an error) for every "can't resolve" case: no agentId, a dead/unknown agent, or a
  // live agent whose cwd isn't under any registered project, or a project with no bound
  // queue — the caller (workflow.run above) decides what null means (fail, or provision).
  private resolveCallerProjectQueue(agentId: string | null): string | null {
    if (!agentId) return null;
    let cwd: string;
    try { cwd = this.deps.supervisor.status(agentId).spec.cwd; } catch { return null; }
    const project = this.deps.projects.list().find((p) => isPathUnder(cwd, p.path));
    return project?.queue ?? null;
  }

  // provision:true's escape hatch: a scratch queue + a one-role team bound to it, so a
  // conductor with no project/queue context can still dispatch a dynamic workflow. The
  // role's cwd is the calling agent's own cwd (isolation:"none" — it works directly in
  // that repo, same as dispatch()'s "direct" last resort) when resolvable, else this.home.
  private async provisionScratch(agentId: string | null): Promise<string> {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
    const queueName = `wfrun-${suffix}`;
    this.deps.queues.create({ name: queueName });
    let cwd = this.deps.home;
    if (agentId) { try { cwd = this.deps.supervisor.status(agentId).spec.cwd; } catch { /* fall back to home */ } }
    this.deps.teams.create({
      name: `wfrun-team-${suffix}`, queue: queueName,
      purpose: "scratch team auto-provisioned by workflow_run (provision:true)",
      // ROLES-UNIFY §3.1: a role slot is a {role, overrides} binding now — "blank" (always
      // present, RoleStore self-seeds the 4 builtins) is the library entry every field here
      // overrides, same as this scratch role never referenced any other library role before.
      roles: { runner: { role: "blank", overrides: { cwd, isolation: "none" } } },
    });
    await this.deps.scheduler.tick();
    return queueName;
  }
}
