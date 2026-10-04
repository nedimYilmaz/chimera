import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// LIVE-MODEL-CHIPS: same harness as SpawnCard.test.tsx (rpc/bridge stubbed so this
// only exercises ModelCard's own providers.models wiring against a scripted rpc) and
// WorkflowFormCard.test.tsx (OverlayCard's esc-key effect needs a bare window stub —
// this package's vitest config runs a node env, no jsdom).
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

import { ModelCard } from "../src/components/ModelCard";
import { appStore } from "../src/state/store";
import { systemLocal } from "../src/state/commands.system";

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

function chipText(n: TreeNode): string {
  return (n.children ?? []).join("");
}

function selectAgent(agentId: string, provider?: string, accountName?: string): void {
  appStore.dispatch({
    type: "agentRecords",
    records: [{
      agentId, state: "running",
      accountName: accountName ?? "", provider: provider ?? "",
      costUsd: 0, createdAt: 0,
    }],
  });
  appStore.dispatch({ type: "selectAgent", agentId });
}

let renderer: ReturnType<typeof create> | null = null;

async function renderModelCard(): Promise<ReturnType<typeof create>> {
  await act(async () => {
    renderer = create(React.createElement(ModelCard));
  });
  // one macrotask yield drains the providers.models microtask chain.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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
  systemLocal.set({ modelOpen: false });
});

describe("ModelCard — live model chips", () => {
  it("renders chips from a live providers.models probe, using displayName as label and the raw id as the applied value", async () => {
    selectAgent("a-claude", "claude", "main");
    rpcImpl.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "providers.models") {
        expect(params).toEqual({ provider: "claude", account: "main" });
        return {
          models: ["claude-opus-4-8", "claude-sonnet-5"], source: "live",
          modelDetails: [
            { value: "claude-opus-4-8", displayName: "Claude Opus 4.8" },
            { value: "claude-sonnet-5", displayName: "claude-sonnet-5" }, // same as value — no label override
          ],
        };
      }
      return {};
    });
    systemLocal.set({ modelOpen: true });
    const r = await renderModelCard();
    const tree = r.toJSON() as TreeNode;
    const chips = byAttr(tree, "data-model-chip");
    expect(chips.map((c) => c.props["data-model-chip"])).toEqual(["claude-opus-4-8", "claude-sonnet-5"]);
    expect(chipText(chips[0]!)).toBe("Claude Opus 4.8");
    expect(chipText(chips[1]!)).toBe("claude-sonnet-5");

    act(() => { (chips[0]!.props["onClick"] as () => void)(); });
    const [apply] = byAttr(r.toJSON() as TreeNode, "data-model-apply");
    act(() => { (apply!.props["onClick"] as () => void)(); });
    const setModelCall = rpcImpl.mock.calls.find(([method]) => method === "agent.setModel");
    expect(setModelCall).toBeTruthy();
    expect((setModelCall as [string, { model: string }])[1].model).toBe("claude-opus-4-8");
  });

  // DYNAMIC-MODEL-LISTS: there is no static fallback list any more. The card used to seed from a
  // hardcoded claude-only array, so a codex or kimi agent was offered CLAUDE model names whenever
  // the probe couldn't answer — a wrong suggestion that submits cleanly and fails at the provider.
  // Showing nothing is the correct degradation: the input stays free-text either way.
  it("shows NO chips (never another provider's names) when the agent has no provider to probe for", async () => {
    selectAgent("a-noprovider");
    systemLocal.set({ modelOpen: true });
    const r = await renderModelCard();
    expect(byAttr(r.toJSON() as TreeNode, "data-model-chip")).toEqual([]);
    expect(rpcImpl.mock.calls.some(([method]) => method === "providers.models")).toBe(false);
  });

  it("shows no chips when the live probe fails, rather than inventing a list", async () => {
    selectAgent("a-fail", "claude", "main");
    rpcImpl.mockImplementation(async (method: string) => {
      if (method === "providers.models") throw new Error("boom");
      return {};
    });
    systemLocal.set({ modelOpen: true });
    const r = await renderModelCard();
    const chips = byAttr(r.toJSON() as TreeNode, "data-model-chip");
    expect(chips).toEqual([]);
  });

  it("shows no chips when the live probe returns an empty model list", async () => {
    selectAgent("a-empty", "claude", "main");
    rpcImpl.mockImplementation(async (method: string) => {
      if (method === "providers.models") return { models: [], source: "live" };
      return {};
    });
    systemLocal.set({ modelOpen: true });
    const r = await renderModelCard();
    const chips = byAttr(r.toJSON() as TreeNode, "data-model-chip");
    expect(chips).toEqual([]);
  });

  it("stale-guard: an older in-flight probe (from a since-changed agent) never overwrites the newer result", async () => {
    selectAgent("a-slow", "claude", "slow-account");
    let resolveSlow!: (v: unknown) => void;
    const slow = new Promise((resolve) => { resolveSlow = resolve; });
    rpcImpl.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "providers.models") {
        const account = (params as { account?: string }).account;
        if (account === "slow-account") return slow;
        return { models: ["fast-model"], source: "live" };
      }
      return {};
    });
    systemLocal.set({ modelOpen: true });
    await act(async () => {
      renderer = create(React.createElement(ModelCard));
    });

    // reopen for a different (faster-resolving) account before the slow probe settles —
    // this must win even though the slow probe resolves AFTER it.
    act(() => { systemLocal.set({ modelOpen: false }); });
    selectAgent("a-fast", "claude", "fast-account");
    act(() => { systemLocal.set({ modelOpen: true }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    let chips = byAttr(renderer!.toJSON() as TreeNode, "data-model-chip");
    expect(chips.map((c) => c.props["data-model-chip"])).toEqual(["fast-model"]);

    // now let the stale slow probe resolve — it must NOT clobber the fast result.
    await act(async () => {
      resolveSlow({ models: ["stale-model"], source: "live" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    chips = byAttr(renderer!.toJSON() as TreeNode, "data-model-chip");
    expect(chips.map((c) => c.props["data-model-chip"])).toEqual(["fast-model"]);
  });

  it("STALE-STATE-SWEEP: re-seeds from the newly selected agent when selection changes while the card stays OPEN (AgentList sits in the left rail, outside the overlay scrim, so a row click can retarget `agent` without unmounting this card)", async () => {
    selectAgent("agent-a", "claude", "acct-a");
    systemLocal.set({ modelOpen: true });
    const r = await renderModelCard();

    // user types a custom model string meant for agent-a...
    const [input] = byAttr(r.toJSON() as TreeNode, "data-model-input");
    act(() => { (input!.props["onChange"] as (e: unknown) => void)({ target: { value: "agent-a-custom-model" } }); });
    expect((byAttr(r.toJSON() as TreeNode, "data-model-input")[0]!.props["value"])).toBe("agent-a-custom-model");

    // ...then, WITHOUT closing the card, selection moves to agent-b (a left-rail row click).
    act(() => { selectAgent("agent-b", "claude", "acct-b"); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const inputAfter = byAttr(r.toJSON() as TreeNode, "data-model-input")[0]!;
    expect(inputAfter.props["value"]).not.toBe("agent-a-custom-model");

    // DYNAMIC-MODEL-LISTS: agent-b has no model of its own, so the re-seed leaves the field BLANK
    // (it used to be pre-filled with a hardcoded first choice, which is how another provider's
    // model could be applied by someone who just pressed Enter). Applying is therefore inert —
    // what must never happen, either way, is agent-a's typed string reaching agent-b.
    const [apply] = byAttr(r.toJSON() as TreeNode, "data-model-apply");
    act(() => { (apply!.props["onClick"] as () => void)(); });
    const leaked = rpcImpl.mock.calls.find(
      ([method, params]) => method === "agent.setModel" && (params as { model?: string })?.model === "agent-a-custom-model",
    );
    expect(leaked).toBeUndefined();
  });
});
