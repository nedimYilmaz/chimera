import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// STALE-STATE-SWEEP: same harness as ModelCard.test.tsx (this package's vitest
// config runs a node env, no jsdom — OverlayCard's esc-key effect needs a bare
// window stub).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const rpcImpl = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({}));

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}),
  exportCsv: vi.fn(async () => ""),
  checkpointFilesSince: vi.fn(async () => 0),
}));

import { EffortCard } from "../src/components/EffortCard";
import { appStore } from "../src/state/store";
import { systemLocal } from "../src/state/commands.system";
import { CAPABILITY_NOTES } from "../src/copy";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) {
    if (typeof child !== "string") findAll(child, pred, out);
  }
  return out;
}

function byAttr(tree: TreeNode, attr: string): TreeNode[] {
  return findAll(tree, (n) => attr in n.props);
}

function selectAgent(agentId: string, provider = ""): void {
  appStore.dispatch({
    type: "agentRecords",
    records: [{ agentId, state: "running", accountName: "", provider, costUsd: 0, createdAt: 0 }],
  });
  appStore.dispatch({ type: "selectAgent", agentId });
}

let renderer: ReturnType<typeof create> | null = null;

async function renderEffortCard(): Promise<ReturnType<typeof create>> {
  await act(async () => {
    renderer = create(React.createElement(EffortCard));
  });
  return renderer!;
}

beforeEach(() => {
  rpcImpl.mockReset();
  rpcImpl.mockImplementation(async () => ({}));
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  systemLocal.set({ effortOpen: false });
});

describe("EffortCard — stale-state-on-agent-switch", () => {
  it("STALE-STATE-SWEEP: re-seeds from the newly selected agent when selection changes while the card stays OPEN", async () => {
    selectAgent("agent-a");
    systemLocal.set({ effortOpen: true });
    const r = await renderEffortCard();

    const [input] = byAttr(r.toJSON() as TreeNode, "data-effort-input");
    act(() => { (input!.props["onChange"] as (e: unknown) => void)({ target: { value: "agent-a-custom-effort" } }); });
    expect(byAttr(r.toJSON() as TreeNode, "data-effort-input")[0]!.props["value"]).toBe("agent-a-custom-effort");

    // selection moves to agent-b WITHOUT closing the card (a left-rail row click).
    act(() => { selectAgent("agent-b"); });

    const inputAfter = byAttr(r.toJSON() as TreeNode, "data-effort-input")[0]!;
    expect(inputAfter.props["value"]).not.toBe("agent-a-custom-effort");

    const [apply] = byAttr(r.toJSON() as TreeNode, "data-effort-apply");
    act(() => { (apply!.props["onClick"] as () => void)(); });
    const setEffortCall = rpcImpl.mock.calls.find(([method]) => method === "agent.setEffort");
    expect((setEffortCall as [string, { agentId: string; effort: string }])[1].agentId).toBe("agent-b");
    expect((setEffortCall as [string, { agentId: string; effort: string }])[1].effort).not.toBe("agent-a-custom-effort");
  });
});

// KIMI-BACKEND S6 (spec docs/superpowers/specs/2026-07-28-kimi-backend.md §11-S6): the live
// "change effort" card must warn that Kimi only exposes a thinking on/off toggle here — an
// operator dialing a running kimi agent's effort to e.g. "high" must not be misled into
// thinking it lands as anything more specific than thinking-on.
describe("EffortCard — kimi effort downgrade note", () => {
  it("renders the note for a kimi agent", async () => {
    selectAgent("agent-kimi", "kimi");
    systemLocal.set({ effortOpen: true });
    const r = await renderEffortCard();
    const notes = byAttr(r.toJSON() as TreeNode, "data-kimi-effort-note");
    expect(notes).toHaveLength(1);
    expect((notes[0]!.children as string[]).join("")).toBe(CAPABILITY_NOTES.kimiEffortDowngrade);
  });

  it("does not render the note for a claude agent", async () => {
    selectAgent("agent-claude", "claude");
    systemLocal.set({ effortOpen: true });
    const r = await renderEffortCard();
    expect(byAttr(r.toJSON() as TreeNode, "data-kimi-effort-note")).toHaveLength(0);
  });

  it("does not render the note for a codex agent", async () => {
    selectAgent("agent-codex", "codex");
    systemLocal.set({ effortOpen: true });
    const r = await renderEffortCard();
    expect(byAttr(r.toJSON() as TreeNode, "data-kimi-effort-note")).toHaveLength(0);
  });
});
