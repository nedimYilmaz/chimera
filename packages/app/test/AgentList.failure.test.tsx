import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// F08: the fleet list's failure badge — a failed row's state cell already carries the ✗ glyph,
// this is the trailing text that says WHY (rate-limited vs bad credential vs unretryable request).
// Same plain-node harness as AgentList.seen.test.tsx (no jsdom — window/localStorage are shimmed).
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
}
const storageBacking = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (storageBacking.has(k) ? storageBacking.get(k)! : null),
  setItem: (k: string, v: string) => { storageBacking.set(k, v); },
  removeItem: (k: string) => { storageBacking.delete(k); },
};

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { AgentList } from "../src/components/AgentList";
import { appStore } from "../src/state/store";

const SHOW_DONE_KEY = "chimera.agentList.showDone";
let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  localStorage.removeItem(SHOW_DONE_KEY);
});

// failed/done are both terminal states, hidden by default (AGENTS-HIDE-DONE) — every test here
// needs the row visible to assert on its badge text.
const mount = (): void => {
  localStorage.setItem(SHOW_DONE_KEY, "1");
  act(() => { mounted = create(React.createElement(AgentList)); });
};
const rowText = (agentId: string): string => {
  const row = mounted!.root.find((n) => n.props["data-agent-row"] === agentId);
  return row.findAll((n) => typeof n.props["children"] === "string" || Array.isArray(n.props["children"]))
    .flatMap((n) => (Array.isArray(n.props["children"]) ? n.props["children"] : [n.props["children"]]))
    .filter((x): x is string => typeof x === "string")
    .join("");
};

describe("AgentList failure badge (F08)", () => {
  it("a failed row with a classified failure shows the shared cause label", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [
          { agentId: "a1", state: "failed", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, failure: { cause: "account-cap" } },
        ],
      });
    });
    mount();
    expect(rowText("a1")).toContain("⚠ account capped");
  });

  it("a failed row with no failure record shows no badge", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [
          { agentId: "a2", state: "failed", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1 },
        ],
      });
    });
    mount();
    expect(rowText("a2")).not.toContain("⚠");
  });

  it("a done row with a stale failure record shows no badge (badge is gated on state === failed)", () => {
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [
          { agentId: "a3", state: "done", accountName: "main", provider: "claude", costUsd: 0, createdAt: 1, failure: { cause: "credential" } },
        ],
      });
    });
    mount();
    expect(rowText("a3")).not.toContain("⚠");
  });
});
