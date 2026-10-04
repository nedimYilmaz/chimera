// ACCOUNT-QUOTA-METERS — AccountsChip's per-account border meters. Same harness as
// TopBar.test.tsx (real appStore singleton, rpc/bridge mocked, bare window shim — this
// package's vitest env is plain node, no jsdom).
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

import { AccountsChip } from "../src/components/TopBarChips";
import { appStore } from "../src/state/store";
import { accountToneVar } from "../src/state/selectors";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };
function findAll(node: TreeNode | null, pred: (n: TreeNode) => boolean, out: TreeNode[] = []): TreeNode[] {
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const child of node.children ?? []) if (typeof child !== "string") findAll(child, pred, out);
  return out;
}

let mounted: ReturnType<typeof create> | null = null;
afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

function statusWith(accounts: unknown[]) {
  return { protocolVersion: 1, agents: { running: 0, done: 0, failed: 0, killed: 0 }, accounts };
}

describe("AccountsChip quota borders", () => {
  it("a live session window renders a tone-colored gradient fill + pace notch on the TOP edge", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([{
          name: "a", provider: "claude", cooling: false, coolingUntil: null,
          quota: { account: "a", fetchedAt: 0, windows: [{ kind: "session", usedFraction: 0.3, windowStartedAt: Date.now() - 1_000_000, resetsAt: Date.now() + 1_000_000 }] },
        }]) as never,
      });
    });
    act(() => { mounted = create(React.createElement(AccountsChip)); });
    const root = mounted!.root as unknown as TreeNode;
    const box = findAll(root, (n) => n.props["data-account-box"] === "a")[0]!;
    const edges = findAll(box, (n) => (n.props["className"] as string | undefined)?.includes("quotaEdge") ?? false);
    expect(edges.length).toBeGreaterThan(0);
    const topEdge = edges.find((n) => (n.props["className"] as string).includes("quotaEdgeTop") && !(n.props["className"] as string).includes("quotaNotch"));
    expect(topEdge).toBeDefined();
    const bg = (topEdge!.props["style"] as { background?: string }).background ?? "";
    expect(bg).toContain("linear-gradient");
    expect(bg).toContain("var(--success)");   // 30% used -> under both spendTone thresholds
    const notch = findAll(box, (n) => (n.props["className"] as string | undefined)?.includes("quotaNotch") ?? false);
    expect(notch.length).toBeGreaterThan(0);   // pace marker present when window-start data exists
  });

  it("no quota data renders a flat neutral track on both edges, never a fabricated fill", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([{ name: "codexacct", provider: "codex", cooling: false, coolingUntil: null }]) as never,
      });
    });
    act(() => { mounted = create(React.createElement(AccountsChip)); });
    const root = mounted!.root as unknown as TreeNode;
    const box = findAll(root, (n) => n.props["data-account-box"] === "codexacct")[0]!;
    const edges = findAll(box, (n) => (n.props["className"] as string | undefined)?.includes("quotaEdge") ?? false)
      .filter((n) => !(n.props["className"] as string).includes("quotaNotch"));
    for (const e of edges) expect((e.props["style"] as { background?: string }).background).toBe("var(--line-soft)");
    const notch = findAll(box, (n) => (n.props["className"] as string | undefined)?.includes("quotaNotch") ?? false);
    expect(notch).toHaveLength(0);   // no window-start data -> pace marker cleanly absent, not faked
  });

  it("a STALE window (past resetsAt) also renders the flat neutral track, not a plausible-looking fill", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([{
          name: "b", provider: "claude", cooling: false, coolingUntil: null,
          quota: { account: "b", fetchedAt: 0, windows: [{ kind: "session", usedFraction: 0.9, windowStartedAt: -1_000, resetsAt: -1 }] },
        }]) as never,
      });
    });
    act(() => { mounted = create(React.createElement(AccountsChip)); });
    const root = mounted!.root as unknown as TreeNode;
    const box = findAll(root, (n) => n.props["data-account-box"] === "b")[0]!;
    const topEdge = findAll(box, (n) => (n.props["className"] as string | undefined)?.includes("quotaEdgeTop") ?? false)
      .find((n) => !(n.props["className"] as string).includes("quotaNotch"))!;
    expect((topEdge.props["style"] as { background?: string }).background).toBe("var(--line-soft)");
  });

  it("cooling wins over quota — a high-usage window still renders the flat neutral track while cooling", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([{
          name: "c", provider: "claude", cooling: true, coolingUntil: Date.now() + 60_000,
          quota: { account: "c", fetchedAt: 0, windows: [{ kind: "session", usedFraction: 0.99, windowStartedAt: 0, resetsAt: Date.now() + 1_000_000 }] },
        }]) as never,
      });
    });
    act(() => { mounted = create(React.createElement(AccountsChip)); });
    const root = mounted!.root as unknown as TreeNode;
    const box = findAll(root, (n) => n.props["data-account-box"] === "c")[0]!;
    const topEdge = findAll(box, (n) => (n.props["className"] as string | undefined)?.includes("quotaEdgeTop") ?? false)
      .find((n) => !(n.props["className"] as string).includes("quotaNotch"))!;
    expect((topEdge.props["style"] as { background?: string }).background).toBe("var(--line-soft)");   // no danger tint despite 99% used
  });

  it("QUOTA-BARS-USE-ACCOUNT-COLOR: normal (success) fill uses the account's OWN color, not a generic success tone", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([
          { name: "main", provider: "claude", cooling: false, coolingUntil: null },
          {
            name: "z", provider: "claude", cooling: false, coolingUntil: null,
            quota: { account: "z", fetchedAt: 0, windows: [{ kind: "session", usedFraction: 0.3, windowStartedAt: Date.now() - 1_000_000, resetsAt: Date.now() + 1_000_000 }] },
          },
        ]) as never,
      });
    });
    act(() => { mounted = create(React.createElement(AccountsChip)); });
    const root = mounted!.root as unknown as TreeNode;
    const box = findAll(root, (n) => n.props["data-account-box"] === "z")[0]!;
    const topEdge = findAll(box, (n) => (n.props["className"] as string | undefined)?.includes("quotaEdgeTop") ?? false)
      .find((n) => !(n.props["className"] as string).includes("quotaNotch"))!;
    const bg = (topEdge.props["style"] as { background?: string }).background ?? "";
    expect(bg).toContain(`var(${accountToneVar("z")})`);   // "z" isn't the "main" account -> its own hash-slot color
    expect(bg).not.toContain("var(--success)");
    const nameSpan = findAll(box, (n) => Boolean((n.props["style"] as { color?: string } | undefined)?.color))[0]!;
    expect((nameSpan.props["style"] as { color?: string }).color).toBe(`var(${accountToneVar("z")})`);
  });

  it("QUOTA-BARS-USE-ACCOUNT-COLOR: at warn/danger the tone color TAKES OVER from the account color — the limit warning stays legible", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([
          { name: "main", provider: "claude", cooling: false, coolingUntil: null },
          {
            name: "z", provider: "claude", cooling: false, coolingUntil: null,
            quota: { account: "z", fetchedAt: 0, windows: [{ kind: "session", usedFraction: 0.95, windowStartedAt: Date.now() - 1_000_000, resetsAt: Date.now() + 1_000_000 }] },
          },
        ]) as never,
      });
    });
    act(() => { mounted = create(React.createElement(AccountsChip)); });
    const root = mounted!.root as unknown as TreeNode;
    const box = findAll(root, (n) => n.props["data-account-box"] === "z")[0]!;
    const topEdge = findAll(box, (n) => (n.props["className"] as string | undefined)?.includes("quotaEdgeTop") ?? false)
      .find((n) => !(n.props["className"] as string).includes("quotaNotch"))!;
    const bg = (topEdge.props["style"] as { background?: string }).background ?? "";
    expect(bg).toContain("var(--danger)");
    expect(bg).not.toContain(`var(${accountToneVar("z")})`);
    // identity color still on the name label — only the METER fill escalates to alarm.
    const nameSpan = findAll(box, (n) => Boolean((n.props["style"] as { color?: string } | undefined)?.color))[0]!;
    expect((nameSpan.props["style"] as { color?: string }).color).toBe(`var(${accountToneVar("z")})`);
  });

  it("the chip title states the top=session/bottom=weekly legend explicitly", () => {
    act(() => {
      appStore.dispatch({
        type: "daemonStatus",
        status: statusWith([{
          name: "a", provider: "claude", cooling: false, coolingUntil: null,
          quota: { account: "a", fetchedAt: 0, windows: [{ kind: "session", usedFraction: 0.3, windowStartedAt: Date.now() - 1_000_000, resetsAt: Date.now() + 1_000_000 }] },
        }]) as never,
      });
    });
    act(() => { mounted = create(React.createElement(AccountsChip)); });
    const root = mounted!.root as unknown as TreeNode;
    const box = findAll(root, (n) => n.props["data-account-box"] === "a")[0]!;
    expect(box.props["title"] as string).toContain("top border = session, bottom border = weekly");
  });
});
