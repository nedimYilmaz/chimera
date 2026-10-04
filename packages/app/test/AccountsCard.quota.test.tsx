// ACCOUNT-QUOTA-METERS Layer 2 — the AccountsCard detail block (session/weekly rows, used %,
// absolute reset, relative countdown — nothing hover-only). Same harness as
// TopBarChips.quota.test.tsx.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

// AccountsCard has no named export — it self-registers as an overlay at module-eval time
// (registerOverlay("system.accounts", ...)) and is mounted through OverlayOutlet, same as the
// real app and the same convention CommandPalette.test.tsx uses.
import "../src/components/AccountsCard";
import { OverlayOutlet } from "../src/components/OverlayOutlet";
import { appStore } from "../src/state/store";

function renderAccountsCard() {
  return React.createElement(OverlayOutlet, { host: "agents", bottomInset: 0 });
}

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) if (typeof child !== "string") findAll(child, pred, out);
  return out;
}
function textOf(node: TreeNode): string {
  return (node.children ?? []).map((c) => (typeof c === "string" ? c : textOf(c))).join("");
}

let mounted: ReturnType<typeof create> | null = null;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

function statusWith(accounts: unknown[]) {
  return { protocolVersion: 1, agents: { running: 0, done: 0, failed: 0, killed: 0 }, accounts };
}

describe("AccountsCard quota block", () => {
  it("renders a labelled row per window with used%, absolute reset, and relative countdown — nothing hover-only", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([{
          name: "a", provider: "claude", cooling: false, coolingUntil: null,
          quota: {
            account: "a", fetchedAt: 0,
            windows: [
              { kind: "session", usedFraction: 0.58, windowStartedAt: Date.now() - 1_000_000, resetsAt: Date.now() + 1_000_000 },
              { kind: "weekly", usedFraction: 0.91, windowStartedAt: Date.now() - 5_000_000, resetsAt: Date.now() + 5_000_000 },
            ],
          },
        }]) as never,
      });
      appStore.dispatch({ type: "accountsOpen", open: true });
    });
    act(() => { mounted = create(renderAccountsCard()); });
    const root = mounted!.root as unknown as TreeNode;
    const block = findAll(root, (n) => n.props["data-quota-block"] === "a")[0]!;
    expect(block).toBeDefined();
    expect(textOf(block)).toContain("top-bar chip border: top = session, bottom = weekly");

    const sessionRow = findAll(block, (n) => n.props["data-quota-row"] === "session")[0]!;
    const sessionText = textOf(sessionRow);
    expect(sessionText).toContain("58%");
    expect(sessionText).toContain("resets in");   // relative countdown present

    const weeklyRow = findAll(block, (n) => n.props["data-quota-row"] === "weekly")[0]!;
    const weeklyText = textOf(weeklyRow);
    expect(weeklyText).toContain("91%");
    expect(weeklyText).toContain("in ");   // "<abs> (in <rel>)" form
  });

  it("an account with no window data and no reason recorded renders NO quota block (nothing to fabricate)", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([{ name: "codexacct", provider: "codex", cooling: false, coolingUntil: null }]) as never,
      });
      appStore.dispatch({ type: "accountsOpen", open: true });
    });
    act(() => { mounted = create(renderAccountsCard()); });
    const root = mounted!.root as unknown as TreeNode;
    expect(findAll(root, (n) => n.props["data-quota-block"] === "codexacct")).toHaveLength(0);
  });

  // QUOTA-ABSENCE-IS-INVISIBLE: with no bars, the reason line distinguishes "not supported"
  // from "polling is failing" from "polled fine, nothing to show" — never blank, never a figure.
  it("unsupported auth type renders a reason line, not blank", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([{
          name: "codexacct", provider: "codex", cooling: false, coolingUntil: null,
          quotaReason: { kind: "unsupported", at: Date.now() },
        }]) as never,
      });
      appStore.dispatch({ type: "accountsOpen", open: true });
    });
    act(() => { mounted = create(renderAccountsCard()); });
    const root = mounted!.root as unknown as TreeNode;
    const block = findAll(root, (n) => n.props["data-quota-block"] === "codexacct")[0]!;
    expect(block).toBeDefined();
    expect(block.props["data-quota-reason"]).toBe("unsupported");
    expect(textOf(block)).toContain("no quota source for this auth type");
  });

  it("a failed poll (429) renders the status code and last-tried time, not blank", () => {
    const at = Date.now();
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([{
          name: "claude-pers", provider: "claude", cooling: false, coolingUntil: null,
          quotaReason: { kind: "rate_limited", httpStatus: 429, at },
        }]) as never,
      });
      appStore.dispatch({ type: "accountsOpen", open: true });
    });
    act(() => { mounted = create(renderAccountsCard()); });
    const root = mounted!.root as unknown as TreeNode;
    const block = findAll(root, (n) => n.props["data-quota-block"] === "claude-pers")[0]!;
    const text = textOf(block);
    expect(text).toContain("429");
    expect(text).toContain("last tried");
  });

  it("a reason is present but windows also exist — bars render, reason line does not (bars win)", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([{
          name: "a", provider: "claude", cooling: false, coolingUntil: null,
          quotaReason: { kind: "ok", at: Date.now() },
          quota: {
            account: "a", fetchedAt: 0,
            windows: [{ kind: "session", usedFraction: 0.5, windowStartedAt: Date.now() - 1000, resetsAt: Date.now() + 1000 }],
          },
        }]) as never,
      });
      appStore.dispatch({ type: "accountsOpen", open: true });
    });
    act(() => { mounted = create(renderAccountsCard()); });
    const root = mounted!.root as unknown as TreeNode;
    const block = findAll(root, (n) => n.props["data-quota-block"] === "a")[0]!;
    expect(block.props["data-quota-reason"]).toBeUndefined();
    expect(findAll(block, (n) => n.props["data-quota-row"] === "session")).toHaveLength(1);
  });

  it("a stale window (past resetsAt) renders the degraded caveat, not a live-looking bar", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([{
          name: "b", provider: "claude", cooling: false, coolingUntil: null,
          quota: { account: "b", fetchedAt: 0, windows: [{ kind: "session", usedFraction: 0.7, windowStartedAt: -2000, resetsAt: -1 }] },
        }]) as never,
      });
      appStore.dispatch({ type: "accountsOpen", open: true });
    });
    act(() => { mounted = create(renderAccountsCard()); });
    const root = mounted!.root as unknown as TreeNode;
    const row = findAll(root, (n) => n.props["data-quota-row"] === "session")[0]!;
    expect(row.props["data-quota-state"]).toBe("stale");
    expect(textOf(row)).toContain("stale");
  });

  it("a window kind that never arrived (e.g. weekly) renders its own row as 'no data'", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([{
          name: "c", provider: "claude", cooling: false, coolingUntil: null,
          quota: { account: "c", fetchedAt: 0, windows: [{ kind: "session", usedFraction: 0.2, windowStartedAt: Date.now() - 1000, resetsAt: Date.now() + 1000 }] },
        }]) as never,
      });
      appStore.dispatch({ type: "accountsOpen", open: true });
    });
    act(() => { mounted = create(renderAccountsCard()); });
    const root = mounted!.root as unknown as TreeNode;
    const weeklyRow = findAll(root, (n) => n.props["data-quota-row"] === "weekly")[0]!;
    expect(textOf(weeklyRow)).toContain("no data");
  });
});
