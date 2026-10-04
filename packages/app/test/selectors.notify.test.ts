import { describe, expect, it } from "vitest";
import type { NotifyRule } from "@chimera/protocol";
import {
  buildNotifyRows,
  deepLinkFor,
  fmtThrottle,
  jobNameFromAgentId,
  kindLabel,
  pendingBadgeCount,
} from "../src/state/selectors.notify";

// W20 gate (a): the notify-rules card's pure layer — row shaping, throttle/
// kind labels, and the deep-link routing table (mock showNotifRules, coverage
// B22/C16).

describe("kindLabel (mock row labels)", () => {
  it("maps the 5 shipped default kinds", () => {
    expect(kindLabel("permission_request")).toBe("permission pending");
    expect(kindLabel("agent_question")).toBe("question pending");
    expect(kindLabel("job_run_finished")).toBe("job failed");
    expect(kindLabel("budget_warning")).toBe("budget ≥80%");
    expect(kindLabel("peer_partitioned")).toBe("peer partitioned");
  });
  it("falls back to the bare kind (underscores → spaces) for an unknown kind — on.kind is a free string by design", () => {
    expect(kindLabel("some_future_kind")).toBe("some future kind");
  });
});

describe("fmtThrottle (mock: 1/min · 1/hr · instant)", () => {
  it("formats the shipped-default window", () => {
    expect(fmtThrottle(60)).toBe("1/min");
    expect(fmtThrottle(3600)).toBe("1/hr");
  });
  it("formats an instant (0/negative) window and odd multiples", () => {
    expect(fmtThrottle(0)).toBe("instant");
    expect(fmtThrottle(120)).toBe("1/2min");
    expect(fmtThrottle(45)).toBe("45s");
  });
});

const rule = (over: Partial<NotifyRule> = {}): NotifyRule => ({
  name: "job-failed",
  on: { kind: "job_run_finished", filter: { result: "failed" } },
  channel: "toast",
  throttleSec: 60,
  enabled: true,
  ...over,
});

describe("buildNotifyRows", () => {
  it("shapes a toast rule with its filter hint", () => {
    const [row] = buildNotifyRows([rule()]);
    expect(row).toEqual({
      name: "job-failed",
      kindLabel: "job failed",
      filterLabel: "result=failed",
      channel: "toast",
      channelLabel: "toast",
      throttleLabel: "1/min",
      enabled: true,
    });
  });
  it("labels a webhook rule with the target host", () => {
    const [row] = buildNotifyRows([rule({ channel: "webhook", webhookUrl: "https://ops.example.com/hook" })]);
    expect(row!.channelLabel).toBe("webhook #ops.example.com");
  });
  it("a rule with no filter carries a null filterLabel", () => {
    const [row] = buildNotifyRows([rule({ on: { kind: "peer_partitioned" } })]);
    expect(row!.filterLabel).toBeNull();
  });
});

describe("deepLinkFor (spec: click lands on the ⚠ card / the job row / the peers table)", () => {
  it("permission/question/budget route to the agents tab + the source agent", () => {
    expect(deepLinkFor("permission_request", "a-1")).toEqual({ tab: "agents", agentId: "a-1" });
    expect(deepLinkFor("agent_question", "a-2")).toEqual({ tab: "agents", agentId: "a-2" });
    expect(deepLinkFor("budget_warning", "tree-1")).toEqual({ tab: "agents", agentId: "tree-1" });
  });
  it("job_run_finished routes to the queues tab + the bare job name (agentId is job:<name>)", () => {
    expect(deepLinkFor("job_run_finished", "job:nightly-build")).toEqual({ tab: "queues", jobName: "nightly-build" });
  });
  it("peer_partitioned routes to the settings network section", () => {
    expect(deepLinkFor("peer_partitioned", "federation")).toEqual({ tab: "settings", section: "network" });
  });
  it("an unroutable kind (or a malformed job agentId) is null — never navigates blind", () => {
    expect(deepLinkFor("commands_changed", "x")).toBeNull();
    expect(deepLinkFor("job_run_finished", "not-a-job-id")).toBeNull();
  });
});

describe("jobNameFromAgentId", () => {
  it("strips the job: prefix", () => {
    expect(jobNameFromAgentId("job:nightly-build")).toBe("nightly-build");
  });
  it("null for a non-job agentId", () => {
    expect(jobNameFromAgentId("a-1")).toBeNull();
  });
});

describe("pendingBadgeCount (spec: badge = pending permissions + questions)", () => {
  it("sums pendingPermissions with per-agent pendingQuestion", () => {
    const state = {
      pendingPermissions: [{ requestId: "r1" }, { requestId: "r2" }],
      agentOrder: ["a1", "a2", "a3"],
      agents: {
        a1: { pendingQuestion: { questionId: "q1" } },
        a2: {},
        a3: { pendingQuestion: { questionId: "q2" } },
      },
    };
    expect(pendingBadgeCount(state)).toBe(4);
  });
  it("zero when nothing is pending", () => {
    expect(pendingBadgeCount({ pendingPermissions: [], agentOrder: [], agents: {} })).toBe(0);
  });
});
