import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { NormalizedEvent } from "@chimera/protocol";

// runActionSpy WRAPS the real runAction (rather than replacing it) — this
// file's own "composer arrow-key handling" tests assert on the spy alone,
// but the "composer arrow keys" suite below (COMPOSER-ARROW-STEALS-AGENT)
// needs the REAL dispatch to fire so it can assert on appStore's resulting
// selectedAgentId, not just that runAction was called with the right args.
const runActionSpy = vi.fn();
vi.mock("../src/keymap", async () => {
  const actual = await vi.importActual<typeof import("../src/keymap")>("../src/keymap");
  return { ...actual, runAction: (...args: Parameters<typeof actual.runAction>) => { runActionSpy(...args); return actual.runAction(...args); } };
});

// Composer reaches the singleton app store, whose bridge has import-time Tauri
// listeners in DEV. Keep this render test transport-free and deterministic.
vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => ({})),
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

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

import { Composer } from "../src/components/Composer";
import { composerLocal } from "../src/state/commands.agents";
import { displayName } from "../src/state/selectors";
import { appStore } from "../src/state/store";

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = null;
  composerLocal.reset();
});

const chipText = (): string => {
  const chip = renderer!.root.findByProps({ "data-target-chip": true });
  return chip.children.flatMap((child) => typeof child === "string" ? [child] : child.children).join("");
};

describe("Composer target chip", () => {
  it("defaults to the selected agent, follows selection, and labels the resolved destination", () => {
    const suffix = "composer-target-chip";
    const mainId = `main-${suffix}`;
    const firstId = `codex-eng-3-${suffix}`;
    const secondId = `claude-eng-4-${suffix}`;

    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [
          { agentId: mainId, state: "running", createdAt: 1, spec: { conductor: true } },
          { agentId: firstId, state: "running", createdAt: 2 },
          { agentId: secondId, state: "running", createdAt: 3 },
        ],
      });
      appStore.dispatch({ type: "mainConductorId", agentId: mainId });
      appStore.dispatch({ type: "selectAgent", agentId: firstId });
      composerLocal.reset();
      renderer = create(React.createElement(Composer));
    });

    expect(composerLocal.getState().target).toBe("selected");
    expect(chipText()).toContain(displayName(appStore.getState().agents[firstId]!));

    act(() => appStore.dispatch({ type: "selectAgent", agentId: secondId }));
    expect(composerLocal.getState().target).toBe("selected");
    expect(chipText()).toContain(displayName(appStore.getState().agents[secondId]!));
  });

  it("shows main for the selected-mode fallback and keeps explicit main pickable", () => {
    const mainId = "main-composer-target-fallback";
    const workerId = "worker-composer-target-fallback";
    act(() => {
      appStore.dispatch({
        type: "agentRecords",
        records: [
          { agentId: mainId, state: "running", createdAt: 10, spec: { conductor: true } },
          { agentId: workerId, state: "running", createdAt: 11 },
        ],
      });
      appStore.dispatch({ type: "mainConductorId", agentId: mainId });
      appStore.dispatch({ type: "selectAgent", agentId: mainId });
      composerLocal.reset();
      renderer = create(React.createElement(Composer));
    });

    expect(chipText()).toContain("main");

    act(() => {
      appStore.dispatch({ type: "selectAgent", agentId: workerId });
      composerLocal.set({ target: "main" });
    });
    expect(composerLocal.getState().target).toBe("main");
    expect(chipText()).toContain("main");
    expect(chipText()).not.toContain(displayName(appStore.getState().agents[workerId]!));
  });
});

// FORCE-SEND-MIDTURN: opt+enter (alt+enter) bypasses the busy-hold outbox and
// delivers immediately instead of inserting a newline (newline moved to
// shift+enter, which already worked via the textarea's native default).
describe("alt+enter force-send", () => {
  it("delivers immediately while the target is busy, instead of queuing", () => {
    const agentId = "busy-force-send-composer";
    act(() => {
      appStore.dispatch({ type: "agentRecords", records: [{ agentId, state: "running", createdAt: 1 }] });
      appStore.dispatch({ type: "event", event: { seq: 1, ts: 1, agentId, kind: "tool_call", data: {} } as NormalizedEvent });
      appStore.dispatch({ type: "selectAgent", agentId });
      composerLocal.reset();
      composerLocal.set({ target: "selected", composeText: "urgent context" });
      renderer = create(React.createElement(Composer));
    });
    expect(appStore.getState().agents[agentId]!.busy).toBe(true);

    const textarea = renderer!.root.findByProps({ "data-compose-input": true });
    act(() => {
      (textarea.props as { onKeyDown: (e: unknown) => void }).onKeyDown({
        key: "Enter", altKey: true, shiftKey: false, ctrlKey: false, metaKey: false,
        preventDefault: () => {}, currentTarget: { selectionStart: "urgent context".length },
      });
    });

    expect(appStore.getState().outbox.length).toBe(0);
    const tx = appStore.getState().agents[agentId]!.transcript;
    expect(tx[tx.length - 1]).toMatchObject({ role: "user", text: "urgent context", forced: true });
  });
});

describe("composer arrow-key handling", () => {
  const setup = (composeText: string) => {
    const agentId = "arrow-key-composer";
    act(() => {
      appStore.dispatch({ type: "agentRecords", records: [{ agentId, state: "running", createdAt: 1 }] });
      appStore.dispatch({ type: "selectAgent", agentId });
      composerLocal.reset();
      composerLocal.set({ target: "selected", composeText });
      renderer = create(React.createElement(Composer));
    });
    return renderer!.root.findByProps({ "data-compose-input": true });
  };

  afterEach(() => runActionSpy.mockClear());

  it("empty composer: Up/Down triggers agent-list navigation", () => {
    const textarea = setup("");
    const preventDefault = vi.fn();
    act(() => {
      (textarea.props as { onKeyDown: (e: unknown) => void }).onKeyDown({
        key: "ArrowUp", altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
        preventDefault, currentTarget: { selectionStart: 0 },
      });
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(runActionSpy).toHaveBeenCalledWith("agents.up", appStore);
  });

  it("non-empty composer: Up/Down does NOT trigger agent-list navigation", () => {
    const textarea = setup("hello");
    const preventDefault = vi.fn();
    act(() => {
      (textarea.props as { onKeyDown: (e: unknown) => void }).onKeyDown({
        key: "ArrowDown", altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
        preventDefault, currentTarget: { selectionStart: 5 },
      });
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(runActionSpy).not.toHaveBeenCalledWith("agents.down", appStore);
  });

  it("option+arrow without shift still moves by word (does not preventDefault via runAction path)", () => {
    const textarea = setup("hello world");
    act(() => {
      (textarea.props as { onKeyDown: (e: unknown) => void }).onKeyDown({
        key: "ArrowLeft", altKey: true, shiftKey: false, ctrlKey: false, metaKey: false,
        preventDefault: () => {}, currentTarget: { selectionStart: 11, setSelectionRange: () => {} },
      });
    });
    expect(runActionSpy).not.toHaveBeenCalled();
  });

  it("option+shift+arrow does not collapse the caret (setCaret path skipped)", () => {
    const textarea = setup("hello world");
    const preventDefault = vi.fn();
    act(() => {
      (textarea.props as { onKeyDown: (e: unknown) => void }).onKeyDown({
        key: "ArrowLeft", altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
        preventDefault, currentTarget: { selectionStart: 11 },
      });
    });
    // Falls through to chord forwarding / native handling — never the agent nav
    // path, and never preventDefault from the word-jump handler alone.
    expect(runActionSpy).not.toHaveBeenCalledWith("agents.up", appStore);
    expect(runActionSpy).not.toHaveBeenCalledWith("agents.down", appStore);
  });

  it("cmd+shift+arrow does not collapse the caret (setCaret path skipped)", () => {
    const textarea = setup("hello world");
    act(() => {
      (textarea.props as { onKeyDown: (e: unknown) => void }).onKeyDown({
        key: "ArrowRight", altKey: false, shiftKey: true, ctrlKey: false, metaKey: true,
        preventDefault: () => {}, currentTarget: { selectionStart: 0 },
      });
    });
    expect(runActionSpy).not.toHaveBeenCalledWith("agents.up", appStore);
    expect(runActionSpy).not.toHaveBeenCalledWith("agents.down", appStore);
  });

  it("slash menu open: Up/Down is consumed by the slash popup, not agent nav", () => {
    const textarea = setup("/");
    composerLocal.set({ slashIndex: 0 });
    const preventDefault = vi.fn();
    act(() => {
      (textarea.props as { onKeyDown: (e: unknown) => void }).onKeyDown({
        key: "ArrowDown", altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
        preventDefault, currentTarget: { selectionStart: 1 },
      });
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(runActionSpy).not.toHaveBeenCalledWith("agents.up", appStore);
    expect(runActionSpy).not.toHaveBeenCalledWith("agents.down", appStore);
  });
});

// COMPOSER-ARROW-STEALS-AGENT: ↑↓ must only navigate the agent list when the
// composer is EMPTY — a draft in progress (single- or multi-line) keeps
// arrows as pure caret keys, and the slash palette (when open) keeps first
// claim over them regardless of draft contents.
describe("composer arrow keys", () => {
  const setUpTwoAgents = (suffix: string): { firstId: string; secondId: string } => {
    const firstId = `first-${suffix}`;
    const secondId = `second-${suffix}`;
    appStore.dispatch({
      type: "agentRecords",
      records: [
        { agentId: firstId, state: "running", createdAt: 1 },
        { agentId: secondId, state: "running", createdAt: 2 },
      ],
    });
    appStore.dispatch({ type: "selectAgent", agentId: firstId });
    return { firstId, secondId };
  };

  const pressArrow = (key: "ArrowUp" | "ArrowDown"): { defaultPrevented: boolean } => {
    const textarea = renderer!.root.findByProps({ "data-compose-input": true });
    let defaultPrevented = false;
    act(() => {
      (textarea.props as { onKeyDown: (e: unknown) => void }).onKeyDown({
        key, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
        preventDefault: () => { defaultPrevented = true; },
        currentTarget: { selectionStart: (composerLocal.getState().composeText).length },
      });
    });
    return { defaultPrevented };
  };

  it("does not change the selected agent for a non-empty single-line draft, and does not preventDefault", () => {
    const { firstId } = setUpTwoAgents("arrow-nonempty");
    act(() => {
      composerLocal.reset();
      composerLocal.set({ target: "selected", composeText: "hello world" });
      renderer = create(React.createElement(Composer));
    });

    const result = pressArrow("ArrowUp");

    expect(appStore.getState().selectedAgentId).toBe(firstId);
    expect(result.defaultPrevented).toBe(false);
  });

  it("still navigates agents when the composer is empty", () => {
    const { firstId, secondId } = setUpTwoAgents("arrow-empty");
    act(() => {
      composerLocal.reset();
      composerLocal.set({ target: "selected", composeText: "" });
      renderer = create(React.createElement(Composer));
    });

    const result = pressArrow("ArrowDown");

    expect(appStore.getState().selectedAgentId).toBe(secondId);
    expect(result.defaultPrevented).toBe(true);
  });

  it("leaves the selected agent unchanged for a multi-line draft", () => {
    const { firstId } = setUpTwoAgents("arrow-multiline");
    act(() => {
      composerLocal.reset();
      composerLocal.set({ target: "selected", composeText: "line one\nline two" });
      renderer = create(React.createElement(Composer));
    });

    const result = pressArrow("ArrowUp");

    expect(appStore.getState().selectedAgentId).toBe(firstId);
    expect(result.defaultPrevented).toBe(false);
  });

  it("routes arrows to the slash palette instead of agent-nav while it is open, regardless of draft", () => {
    const { firstId } = setUpTwoAgents("arrow-slash");
    act(() => {
      composerLocal.reset();
      // A bare "/" matches every builtin (status/kill/close/help/spawn/
      // permission, see builtinSlashEntries) without needing any
      // agent-advertised slash commands — plenty of rows to move between.
      composerLocal.set({ target: "selected", composeText: "/", slashIndex: 0 });
      renderer = create(React.createElement(Composer));
    });

    const result = pressArrow("ArrowDown");

    expect(appStore.getState().selectedAgentId).toBe(firstId);
    expect(result.defaultPrevented).toBe(true);
    expect(composerLocal.getState().slashIndex).toBe(1);
  });
});
