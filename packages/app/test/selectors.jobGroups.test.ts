import { describe, expect, it } from "vitest";
import { emptyAgent, type AgentView } from "@chimera/ui-state";
import type { AgentRow } from "../src/state/selectors";
import { groupAgentListRowsByJob } from "../src/state/selectors.jobGroups";
import { JOB_GROUP_DEFAULT_VISIBLE, visibleListRowIds, type AgentListRow } from "../src/state/selectors.workflows";

function agentRow(agentId: string): AgentRow {
  return { kind: "agent", agentId, depth: 0, collapsible: false, collapsed: false, hiddenCount: 0, section: "main" };
}

function jobAgent(agentId: string, jobName: string, createdAt: number): AgentView {
  return { ...emptyAgent(agentId), jobName, createdAt };
}

describe("groupAgentListRowsByJob", () => {
  it("collapses a job with >=2 visible runs into one jobGroup row at the end, newest first", () => {
    const rows: AgentRow[] = [agentRow("conductor"), agentRow("run1"), agentRow("run2"), agentRow("run3")];
    const agents: Record<string, AgentView> = {
      conductor: emptyAgent("conductor"),
      run1: jobAgent("run1", "slack-watch", 1_000),
      run2: jobAgent("run2", "slack-watch", 3_000),
      run3: jobAgent("run3", "slack-watch", 2_000),
    };
    const out = groupAgentListRowsByJob(rows, agents);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(rows[0]);
    expect(out[1]).toMatchObject({ kind: "jobGroup", jobName: "slack-watch", memberIds: ["run2", "run3", "run1"] });
  });

  it("leaves a job with exactly one visible run as an ordinary agent row (no pointless chrome)", () => {
    const rows: AgentRow[] = [agentRow("run1")];
    const agents: Record<string, AgentView> = { run1: jobAgent("run1", "nightly-sync", 1_000) };
    expect(groupAgentListRowsByJob(rows, agents)).toEqual(rows);
  });

  it("leaves non-job agents and task rows untouched", () => {
    const rows: AgentListRow[] = [
      agentRow("a"),
      { kind: "task", taskId: "t1", depth: 0, label: "step · q", state: "in_progress", costUsd: 0, usage: null, stepDots: null },
    ];
    const agents: Record<string, AgentView> = { a: emptyAgent("a") };
    expect(groupAgentListRowsByJob(rows, agents)).toEqual(rows);
  });

  it("is a no-op when nothing has a jobName", () => {
    const rows: AgentRow[] = [agentRow("a"), agentRow("b")];
    const agents: Record<string, AgentView> = { a: emptyAgent("a"), b: emptyAgent("b") };
    expect(groupAgentListRowsByJob(rows, agents)).toEqual(rows);
  });
});

describe("visibleListRowIds with a jobGroup row", () => {
  it("exposes only the default-visible prefix of a group's members for keyboard nav", () => {
    const rows: AgentListRow[] = [
      agentRow("conductor"),
      { kind: "jobGroup", jobName: "slack-watch", memberIds: ["r1", "r2", "r3", "r4", "r5"] },
    ];
    expect(visibleListRowIds(rows)).toEqual(["conductor", ...["r1", "r2", "r3"].slice(0, JOB_GROUP_DEFAULT_VISIBLE)]);
  });
});
