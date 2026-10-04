import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import type { AgentRecordLite } from "@chimera/ui-state";

const rpcImpl = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
  if (method === "agent.interruptMany") return { failed: [] };
  return [];
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { FleetDashboard } from "../src/components/FleetDashboard";
import { appStore } from "../src/state/store";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

// Same singleton-store technique as InboxScreen.test.tsx: appStore is a real
// module-level store with no reset hook, so every test uses uniquely-prefixed
// agent/team/project/queue ids and asserts by exact/substring text match on
// ITS OWN ids only -- cumulative agents from earlier tests never collide.
let seq = 0;
const uid = (prefix: string) => `${prefix}-${(seq += 1)}`;

function record(over: Partial<AgentRecordLite> & { agentId: string }): AgentRecordLite {
  return { state: "running", accountName: "main", provider: "anthropic", costUsd: 0, createdAt: seq, ...over };
}

const seed = (records: AgentRecordLite[]) => act(() => { appStore.dispatch({ type: "agentRecords", records }); });

let mounted: ReactTestRenderer | null = null;
const onOpen = vi.fn();

beforeEach(() => {
  rpcImpl.mockClear();
  onOpen.mockClear();
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

function textNode(root: ReactTestInstance, text: string): ReactTestInstance[] {
  return root.findAll((n) => n.props["children"] === text);
}

// A node's rendered text is JSX-split into several children when a literal
// is interspersed with an `{expression}` (React gives each segment its own
// array entry, e.g. subtitle -> ["...grouped by ", "team", "; select..."]),
// so a substring check has to concatenate the full subtree, not just compare
// a single child verbatim.
function textOf(n: ReactTestInstance | string | number): string {
  if (typeof n === "string") return n;
  if (typeof n === "number") return String(n);
  return n.children.map(textOf).join("");
}

function containingNode(root: ReactTestInstance, substr: string): ReactTestInstance[] {
  return root.findAll((n) => textOf(n).includes(substr));
}

describe("FleetDashboard", () => {
  it("labels the view: subtitle, column header, and group-metric legend", async () => {
    const team = uid("h-team");
    seed([record({ agentId: uid("h-a"), membership: { team, role: "dev" } })]);
    act(() => { mounted = create(React.createElement(FleetDashboard, { onOpen })); });
    await flush();
    const root = mounted!.root;

    expect(containingNode(root, "grouped by team").length).toBeGreaterThan(0);
    expect(textNode(root, "state").length).toBeGreaterThan(0);
    expect(textNode(root, "queue").length).toBeGreaterThan(0);
    expect(textNode(root, "cost").length).toBeGreaterThan(0);
    expect(textNode(root, "tokens").length).toBeGreaterThan(0);
    expect(containingNode(root, "utilization").length).toBeGreaterThan(0);
    expect(containingNode(root, "stalled").length).toBeGreaterThan(0);
  });

  it("defaults to active rows and collapses the done tail behind a +N toggle", async () => {
    const team = uid("d-team");
    const active = [uid("d-active"), uid("d-active")];
    const done = [uid("d-done"), uid("d-done"), uid("d-done")];
    seed([
      ...active.map((agentId) => record({ agentId, state: "running", membership: { team, role: "dev" } })),
      ...done.map((agentId) => record({ agentId, state: "done", membership: { team, role: "dev" } })),
    ]);
    act(() => { mounted = create(React.createElement(FleetDashboard, { onOpen })); });
    await flush();
    const root = mounted!.root;

    for (const id of active) expect(root.findAll((n) => n.props["aria-label"] === `select ${id}`)).toHaveLength(1);
    for (const id of done) expect(root.findAll((n) => n.props["aria-label"] === `select ${id}`)).toHaveLength(0);

    const toggle = root.find((n) => n.props["children"] === "+3 done");
    act(() => { (toggle.props as { onClick: () => void }).onClick(); });
    await flush();

    for (const id of done) expect(root.findAll((n) => n.props["aria-label"] === `select ${id}`)).toHaveLength(1);
  });

  it("reorganizes group heads when the grouping dimension changes", async () => {
    const teamA = uid("g-teamA");
    const teamB = uid("g-teamB");
    const projA = uid("g-projA");
    const projB = uid("g-projB");
    seed([
      record({ agentId: uid("g-a"), membership: { team: teamA, role: "dev" }, projectId: projA }),
      record({ agentId: uid("g-a"), membership: { team: teamB, role: "dev" }, projectId: projB }),
    ]);
    act(() => { mounted = create(React.createElement(FleetDashboard, { onOpen })); });
    await flush();
    const root = mounted!.root;
    // group heads render as <strong> — scoped here because the right-side
    // summary pane ALWAYS shows both team and project breakdowns regardless
    // of the toolbar's active groupBy (by design), so an unscoped text
    // search would find project keys there even while grouped by team.
    const groupHeads = () => root.findAll((n) => n.type === "strong" && typeof n.props["children"] === "string");

    expect(groupHeads().some((n) => n.props["children"] === teamA)).toBe(true);
    expect(groupHeads().some((n) => n.props["children"] === teamB)).toBe(true);
    expect(groupHeads().some((n) => n.props["children"] === projA)).toBe(false);

    const projectBtn = root.find((n) => n.type === "button" && n.props["children"] === "project");
    act(() => { (projectBtn.props as { onClick: () => void }).onClick(); });
    await flush();

    expect(groupHeads().some((n) => n.props["children"] === projA)).toBe(true);
    expect(groupHeads().some((n) => n.props["children"] === projB)).toBe(true);
    expect(containingNode(root, "grouped by project").length).toBeGreaterThan(0);
  });

  // OPERATOR-HOLD: this asserted that "pause" issued agent.interruptMany — which is what the
  // button actually did, and why it was wrong: it aborted the turn and let the agent carry
  // straight on, under a label that promised the opposite. The button is now "hold" and it holds.
  it("bulk-select holds the selection via agent.hold — not an interrupt wearing the word pause", async () => {
    const agentId = uid("b-a");
    seed([record({ agentId, state: "running" })]);
    act(() => { mounted = create(React.createElement(FleetDashboard, { onOpen })); });
    await flush();
    const root = mounted!.root;

    const checkbox = root.find((n) => n.props["aria-label"] === `select ${agentId}`);
    act(() => { (checkbox.props as { onChange: () => void }).onChange(); });
    await flush();

    expect(containingNode(root, "1 selected").length).toBeGreaterThan(0);
    const holdBtn = root.find((n) => n.type === "button" && n.props["children"] === "hold");
    act(() => { (holdBtn.props as { onClick: () => void }).onClick(); });
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("agent.hold", { agentIds: [agentId] });
    // interrupt is still offered beside it — a genuinely different act (abort this turn, keep
    // running), not a synonym
    expect(root.find((n) => n.type === "button" && n.props["children"] === "interrupt")).toBeTruthy();
  });

  it("offers release beside hold — the two are a pair or the fleet is stuck", async () => {
    const agentId = uid("b-r");
    seed([record({ agentId, state: "paused" })]);
    act(() => { mounted = create(React.createElement(FleetDashboard, { onOpen })); });
    await flush();
    const root = mounted!.root;

    const checkbox = root.find((n) => n.props["aria-label"] === `select ${agentId}`);
    act(() => { (checkbox.props as { onChange: () => void }).onChange(); });
    await flush();

    const releaseBtn = root.find((n) => n.type === "button" && n.props["children"] === "release");
    act(() => { (releaseBtn.props as { onClick: () => void }).onClick(); });
    await flush();

    expect(rpcImpl).toHaveBeenCalledWith("agent.release", { agentIds: [agentId] });
  });

  it("populates the right-side fleet summary pane with cost/team/project breakdowns", async () => {
    const teamX = uid("s-teamX");
    const projX = uid("s-projX");
    seed([
      record({ agentId: uid("s-a"), provider: "anthropic", costUsd: 2, membership: { team: teamX, role: "dev" }, projectId: projX }),
      record({ agentId: uid("s-a"), provider: "openai", costUsd: 5, membership: { team: teamX, role: "dev" }, projectId: projX }),
    ]);
    act(() => { mounted = create(React.createElement(FleetDashboard, { onOpen })); });
    await flush();
    const summary = mounted!.root.find((n) => n.props["aria-label"] === "fleet summary");

    expect(containingNode(summary, "fleet summary").length).toBeGreaterThan(0);
    expect(summary.findAll((n) => n.props["children"] === "anthropic").length).toBeGreaterThan(0);
    expect(summary.findAll((n) => n.props["children"] === "openai").length).toBeGreaterThan(0);
    expect(summary.findAll((n) => n.props["children"] === teamX).length).toBeGreaterThan(0);
    expect(summary.findAll((n) => n.props["children"] === projX).length).toBeGreaterThan(0);
  });
});
