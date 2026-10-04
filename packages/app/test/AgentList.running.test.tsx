import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// RUNNING-INDICATOR-PULSE + CONDUCTOR-NAMING: render-level proof for AgentList
// behavior selectors.test.ts can't cover on its own: the busyPulse CSS class
// remains wired to the state glyph, conductorLabel drives conductor rows, and
// ordinary workers keep their deterministic animal names. Same node-env
// shims/render harness as AgentList.fold.test.tsx.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}
if (typeof localStorage === "undefined") {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => { backing.set(k, v); },
    removeItem: (k: string) => { backing.delete(k); },
  };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { AgentList } from "../src/components/AgentList";
import { agentName } from "../src/state/selectors";
import { appStore } from "../src/state/store";

type TreeNode = { type: string; props: Record<string, unknown>; children: (TreeNode | string)[] | null };

function flattenText(node: TreeNode | string | null | undefined): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(flattenText).join("");
}

function walk(node: TreeNode | string | null, visit: (n: TreeNode) => void): void {
  if (!node || typeof node === "string") return;
  visit(node);
  (node.children ?? []).forEach((c) => walk(c as TreeNode, visit));
}

// The onClick-bearing row container whose flattened text carries `idToken` —
// mirrors AgentList.fold.test.tsx's finder. IDs used here are exactly 8 chars
// so a plain (non-conductor) row's shortId secondary label (slice(0, 8))
// renders the id in full and stays locatable this way.
function findRow(root: TreeNode | null, idToken: string): TreeNode | undefined {
  let hit: TreeNode | undefined;
  walk(root, (n) => {
    if (typeof n.props?.onClick === "function" && flattenText(n).includes(idToken) && !hit) hit = n;
  });
  return hit;
}

function findRowByText(root: TreeNode | null, text: string): TreeNode | undefined {
  let hit: TreeNode | undefined;
  walk(root, (n) => {
    if (typeof n.props?.onClick === "function" && flattenText(n).includes(text) && !hit) hit = n;
  });
  return hit;
}

function classNamesIn(node: TreeNode): string[] {
  const out: string[] = [];
  walk(node, (n) => {
    if (typeof n.props?.className === "string") out.push(n.props.className as string);
  });
  return out;
}

function render(): TreeNode {
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(React.createElement(AgentList)); });
  return renderer.toJSON() as TreeNode;
}

describe("AgentList Row — running-indicator pulse (RUNNING-INDICATOR-PULSE)", () => {
  it("a running+busy row's state glyph carries the pulse class", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "bzybusy1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
      // busy is projected from the event stream, not agentRecords — a
      // message_delta drives goBusy() (reducer.ts).
      appStore.dispatch({ type: "event", event: { ts: 1, seq: 1, agentId: "bzybusy1", kind: "message_delta", data: { text: "hi" } } });
    });
    const row = findRow(render(), "bzybusy1");
    expect(row).toBeDefined();
    expect(classNamesIn(row!).some((c) => /busyPulse/.test(c))).toBe(true);
  });

  it("a running-but-idle row's state glyph does NOT carry the pulse class", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "idlerun1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
    });
    const row = findRow(render(), "idlerun1");
    expect(row).toBeDefined();
    expect(classNamesIn(row!).some((c) => /busyPulse/.test(c))).toBe(false);
  });
});

describe("AgentList Row — busy vs. idle state visual (AGENT-STATE-VISUAL)", () => {
  it("a running+busy row's state glyph carries the busy tone, not the idle green", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "bzytone1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
      // seq must exceed every seq already dispatched earlier in this file — the
      // reducer's cross-agent lastSeq dedupe (reducer.ts: `e.seq <= state.lastSeq`)
      // drops an event whose seq doesn't advance the store-wide watermark.
      appStore.dispatch({ type: "event", event: { ts: 1, seq: 50, agentId: "bzytone1", kind: "message_delta", data: { text: "hi" } } });
    });
    const row = findRow(render(), "bzytone1");
    expect(row).toBeDefined();
    const classes = classNamesIn(row!);
    expect(classes.some((c) => /toneBusy/.test(c))).toBe(true);
    expect(classes.some((c) => /toneSuccess/.test(c))).toBe(false);
  });

  it("a running-but-idle row's state glyph stays steady success green with no pulse class", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "idleton1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
    });
    const row = findRow(render(), "idleton1");
    expect(row).toBeDefined();
    const classes = classNamesIn(row!);
    expect(classes.some((c) => /toneSuccess/.test(c))).toBe(true);
    expect(classes.some((c) => /busyPulse/.test(c))).toBe(false);
    expect(classes.some((c) => /toneBusy/.test(c))).toBe(false);
  });

  it("removes the inline state word text while keeping an accessible state label on the glyph", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "a11ystt1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
    });
    const row = findRow(render(), "a11ystt1");
    expect(row).toBeDefined();
    expect(flattenText(row!)).not.toContain("running");
    let glyphSpan: TreeNode | undefined;
    walk(row!, (n) => {
      if (n.type === "span" && n.props?.role === "img") glyphSpan = n;
    });
    expect(glyphSpan).toBeDefined();
    expect(glyphSpan!.props["aria-label"]).toContain("running");
    expect(glyphSpan!.props["title"]).toContain("running");
  });
});

describe("AgentList Row — conductor naming", () => {
  it("renders the project name directly and suffixes multiple live conductors for the same project", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [
          {
            agentId: "cndproj1", state: "running", accountName: "main", provider: "claude",
            costUsd: 0, createdAt: 1, spec: { conductor: true }, projectId: "chimera",
          },
          {
            agentId: "cndproj2", state: "paused", accountName: "main", provider: "claude",
            costUsd: 0, createdAt: 2, spec: { conductor: true }, projectId: "chimera",
          },
        ],
      });
    });
    const tree = render();
    const first = findRowByText(tree, "chimera conductor");
    const second = findRowByText(tree, "chimera-2 conductor");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(flattenText(first)).not.toContain(agentName("cndproj1"));
    expect(flattenText(second)).not.toContain(agentName("cndproj2"));
  });

  it("keeps an ordinary agent's animal name as the primary label", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{
          agentId: "wrkplain", state: "running", accountName: "main", provider: "claude",
          costUsd: 0, createdAt: 3,
        }],
      });
    });
    const row = findRow(render(), "wrkplain");
    expect(row).toBeDefined();
    expect(flattenText(row)).toContain(agentName("wrkplain"));
  });
});

describe("AgentList Row — F09 unacknowledged-prompt badge", () => {
  it('renders the not-picked-up badge with a resend affordance after agent_prompt_stalled', () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [{ agentId: "unackd1", state: "running", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 }],
      });
      // seq must exceed every seq already dispatched earlier in this file — see the
      // lastSeq-watermark note above.
      appStore.dispatch({
        type: "event",
        event: { ts: 1, seq: 9001, agentId: "unackd1", kind: "agent_prompt_stalled", data: { deliveryId: "d1", from: "conductor", sinceTs: 1000, sinceMs: 45000 } },
      });
    });
    const row = findRow(render(), "unackd1");
    expect(row).toBeDefined();
    // QA U1: the badge follows the clock off sinceTs — it must not paint the frozen sinceMs
    // snapshot. Both this assertion and the resend affordance are part of the same badge.
    expect(flattenText(row)).toContain("⚠ start unconfirmed");
    expect(flattenText(row)).toContain("resend");
  });
});


describe("soft limit is not a pause", () => {
  it.each([true, false])("retains running appearance with busy=%s", (busy) => {
    const id = busy ? "softbusy" : "softidle";
    act(() => {
      appStore.dispatch({ type: "agentRecords", records: [{ agentId: id, state: "running", costUsd: 0, createdAt: 1 }] });
      appStore.dispatch({ type: "event", event: { seq: busy ? 9100 : 9200, ts: 1, engineId: "local", agentId: id, kind: "status", data: { turnBudgetExceeded: true } } });
      if (busy) appStore.dispatch({ type: "event", event: { seq: 9101, ts: 2, engineId: "local", agentId: id, kind: "message_delta", data: { text: "still working" } } });
    });
    const row = findRow(render(), id)!;
    let glyph: TreeNode | undefined;
    walk(row, (node) => { if (node.props.role === "img" && String(node.props["aria-label"]).startsWith("running")) glyph = node; });
    expect(glyph).toBeDefined();
    expect(String(glyph!.props.className)).not.toMatch(/toneWarn/);
    expect(String(glyph!.props.className)).toMatch(busy ? /busyPulse/ : /toneSuccess/);
    expect(flattenText(row)).toContain("soft");
  });
});
