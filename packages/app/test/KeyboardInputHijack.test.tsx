// KEYBOARD-INPUT-HIJACK: regression coverage for the audit's confirmed bugs — a hand-rolled
// per-component keydown listener that bypassed the app's central `isEditableTarget` guard
// (src/keymap.ts), so a shortcut could fire while the user was typing in a real field. Every
// case below fires the SAME synthetic keydown twice: once at an editable target (must be a
// no-op) and once at a non-editable target (must still fire) — proving the guard reads the
// actual keydown target, not some unrelated proxy (composer draft length, a stale text
// selection, an incomplete tag allowlist, an explicit bypass list, etc).
//
// Harness FIRST: the keydown-capturing window stub (agents-window-harness.ts, same as
// AgentsScreen.chords.test.tsx) must be installed before any src/ module evaluates.
import { keydownHandlers, fireKeydown } from "./agents-window-harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

type RpcImpl = (method: string, params?: unknown) => Promise<unknown>;
let rpcImpl: RpcImpl = async (method: string) => (method === "daemon.status" ? { protocolVersion: 1, agents: {} } : {});
const openArtifactSnapshotSpy = vi.fn(async () => {});

vi.mock("../src/rpc/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rpc/bridge")>();
  return {
    ...actual,
    rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
    openArtifactSnapshot: (id: string) => openArtifactSnapshotSpy(id),
    readArtifactSnapshot: async () => "",
    subscribeEvents: async () => {},
    onDaemonEvent: () => () => {},
    onDaemonState: () => () => {},
    daemonStatus: async () => "connected",
    setDockBadge: async () => {},
  };
});

// `q`'s selectionMsgKey(pane) reads a real window.getSelection() this node env doesn't have;
// this test isolates the isEditableTarget guard specifically, not the selection machinery
// (which the audit already flagged as the WRONG gate — the point of this fix).
vi.mock("../src/state/copyOnSelect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/state/copyOnSelect")>();
  return { ...actual, selectionMsgKey: () => "m1" };
});

import { ConfirmCard } from "../src/components/ConfirmCard";
import { ReplayBar } from "../src/components/ReplayBar";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { useTranscriptKeyboard } from "../src/components/TranscriptSegment";
import { ReviewRoomScreen } from "../src/screens/ReviewRoomScreen";
import { WorkflowStudio } from "../src/components/WorkflowStudio";
import { useSystemSurfaces } from "../src/App";
import { handleDesktopKey, isMacPlatform, useHotkeys } from "../src/keymap";
import "../src/components/ArtifactPreviewCard";
import "../src/components/RemoteControlCard";
import "../src/components/ResultCard";
import { OverlayOutlet } from "../src/components/OverlayOutlet";
import { appStore } from "../src/state/store";
import { systemLocal } from "../src/state/commands.system";
import { artifactsLocal } from "../src/state/commands.artifacts";

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const EDITABLE = { tagName: "INPUT" };
const NON_EDITABLE = { tagName: "DIV" };

let mounted: ReturnType<typeof create> | null = null;
afterEach(async () => {
  await act(async () => {
    mounted?.unmount();
    await settle();
  });
  mounted = null;
  vi.unstubAllGlobals();
  keydownHandlers.length = 0;
  rpcImpl = async (method: string) => (method === "daemon.status" ? { protocolVersion: 1, agents: {} } : {});
});

describe("ConfirmCard — Enter gates a destructive confirm (CONFIRM-CARD-INPUT-HIJACK)", () => {
  it("Enter at an editable target does not confirm; Enter at a non-editable target does", () => {
    let confirmed = 0;
    act(() => {
      mounted = create(
        React.createElement(ConfirmCard, {
          title: "confirm",
          body: "body",
          confirmLabel: "confirm",
          onConfirm: () => confirmed++,
          onClose: () => {},
        }),
      );
    });
    act(() => fireKeydown({ key: "Enter", target: EDITABLE, stopPropagation: () => {} }));
    expect(confirmed).toBe(0);
    act(() => fireKeydown({ key: "Enter", target: NON_EDITABLE, stopPropagation: () => {} }));
    expect(confirmed).toBe(1);
  });
});

describe("ReplayBar — space/arrows/l are the replay surface's own keys, not a global bypass list (REPLAY-BAR-INPUT-HIJACK)", () => {
  it("'l' at an editable target leaves replay open; 'l' at a non-editable target closes it", () => {
    act(() => {
      systemLocal.set({
        replay: { ...systemLocal.getState().replay, active: true, loading: false, events: [], turn: 0, cutoffSeq: null, playing: false },
      });
    });
    act(() => { mounted = create(React.createElement(ReplayBar)); });
    expect(systemLocal.getState().replay.active).toBe(true);

    act(() => fireKeydown({ key: "l", target: EDITABLE }));
    expect(systemLocal.getState().replay.active).toBe(true);

    act(() => fireKeydown({ key: "l", target: NON_EDITABLE }));
    expect(systemLocal.getState().replay.active).toBe(false);
  });
});

describe("ErrorBoundary — 'r' retries the crashed pane (ERROR-BOUNDARY-INPUT-HIJACK)", () => {
  it("'r' at an editable target leaves the fallback up; 'r' at a non-editable target retries", () => {
    let shouldThrow = true;
    function Boom(): null {
      if (shouldThrow) throw new Error("boom");
      return null;
    }
    act(() => {
      mounted = create(React.createElement(ErrorBoundary, null, React.createElement(Boom)));
    });
    expect(JSON.stringify(mounted!.toJSON())).toContain("retry");

    shouldThrow = false;
    act(() => fireKeydown({ key: "r", target: EDITABLE }));
    expect(JSON.stringify(mounted!.toJSON())).toContain("retry"); // still crashed — no retry happened

    act(() => fireKeydown({ key: "r", target: NON_EDITABLE }));
    expect(mounted!.toJSON()).toBeNull(); // Boom re-rendered clean -> boundary renders children (null)
  });
});

describe("ArtifactPreviewCard — 'o' OS-opens the previewed artifact (ARTIFACT-PREVIEW-INPUT-HIJACK)", () => {
  afterEach(() => {
    act(() => artifactsLocal.set({ previewId: null }));
  });

  it("'o' at an editable target does not open; 'o' at a non-editable target opens", async () => {
    rpcImpl = async (method: string, params?: unknown) => {
      if (method === "artifact.get") {
        return { id: (params as { id: string }).id, kind: "file", label: "a.bin", createdAt: 0, sizeBytes: 10 };
      }
      return {};
    };
    act(() => { mounted = create(React.createElement(OverlayOutlet, { host: "agents" })); });
    act(() => artifactsLocal.set({ previewId: "a1" }));
    await act(async () => { await settle(); await settle(); });

    act(() => fireKeydown({ key: "o", target: EDITABLE }));
    expect(openArtifactSnapshotSpy).not.toHaveBeenCalled();

    act(() => fireKeydown({ key: "o", target: NON_EDITABLE }));
    expect(openArtifactSnapshotSpy).toHaveBeenCalledWith("a1");
  });
});

describe("RemoteControlCard — Enter toggles remote control (REMOTE-CONTROL-CARD-INPUT-HIJACK)", () => {
  afterEach(() => {
    act(() => systemLocal.set({ remoteControlOpen: false }));
  });

  it("Enter at an editable target does not toggle; Enter at a non-editable target does", async () => {
    const calls: unknown[] = [];
    rpcImpl = async (method: string, params?: unknown) => {
      if (method === "agent.remoteControl") { calls.push(params); return { sessionUrl: "u" }; }
      return {};
    };
    act(() => {
      appStore.dispatch({ type: "event", event: { seq: 9001, ts: 1, agentId: "rc-1", kind: "agent_started", data: { model: "m1", provider: "claude" } } } as never);
      appStore.dispatch({ type: "selectAgent", agentId: "rc-1" } as never);
      systemLocal.set({ remoteControlOpen: true });
    });
    act(() => { mounted = create(React.createElement(OverlayOutlet, { host: "agents" })); });

    act(() => fireKeydown({ key: "Enter", target: EDITABLE, stopPropagation: () => {} }));
    await act(async () => settle());
    expect(calls.length).toBe(0);

    act(() => fireKeydown({ key: "Enter", target: NON_EDITABLE, stopPropagation: () => {} }));
    await act(async () => settle());
    expect(calls.length).toBe(1);
  });
});

describe("ResultCard — Enter closes and opens the transcript (RESULT-CARD-INPUT-HIJACK)", () => {
  afterEach(() => {
    act(() => appStore.dispatch({ type: "resultOpen", open: false } as never));
  });

  it("guards on the actually-focused element, not the main composer's draft", () => {
    act(() => {
      appStore.dispatch({ type: "event", event: { seq: 9002, ts: 1, agentId: "res-1", kind: "agent_started", data: { model: "m1" } } } as never);
      appStore.dispatch({ type: "selectAgent", agentId: "res-1" } as never);
      appStore.dispatch({ type: "agentResult", agentId: "res-1", detail: { result: { state: "succeeded", text: "hi", costUsd: 0 }, status: {} } } as never);
      appStore.dispatch({ type: "resultOpen", open: true } as never);
    });
    act(() => { mounted = create(React.createElement(OverlayOutlet, { host: "agents" })); });

    act(() => fireKeydown({ key: "Enter", target: EDITABLE }));
    expect(appStore.getState().resultOpen).toBe(true);

    act(() => fireKeydown({ key: "Enter", target: NON_EDITABLE }));
    expect(appStore.getState().resultOpen).toBe(false);
  });
});

describe("useTranscriptKeyboard — bare v/q act on focus, not stale selection (TRANSCRIPT-SEGMENT-INPUT-HIJACK)", () => {
  it("'q' at an editable target does not quote; 'q' at a non-editable target does", () => {
    const pane = {} as HTMLDivElement;
    const bodyRef = { current: pane };
    let applied = 0;
    function Harness() {
      useTranscriptKeyboard(bodyRef, () => undefined, () => ({ text: "quoted", key: "m1" }) as never, () => { applied++; });
      return null;
    }
    act(() => { mounted = create(React.createElement(Harness)); });

    act(() => fireKeydown({ key: "q", target: EDITABLE }));
    expect(applied).toBe(0);

    act(() => fireKeydown({ key: "q", target: NON_EDITABLE }));
    expect(applied).toBe(1);
  });
});

describe("ReviewRoomScreen — Escape/hunk-nav ignore ANY editable target, not just <input>/<textarea> (REVIEW-ROOM-INPUT-HIJACK)", () => {
  it("Escape at a <select> target (missed by the old matches('input,textarea') check) does not close the room; a non-editable target does", () => {
    // The handler also checks dialog ancestry; Node has no browser Element constructor.
    class TestElement {
      constructor(private readonly inDialog = false) {}
      closest(selector: string) { return this.inDialog && selector === '[role="dialog"]' ? this : null; }
    }
    vi.stubGlobal("Element", TestElement);
    act(() => {
      appStore.dispatch({ type: "reviewRoomOpen", taskId: "t1" } as never);
      appStore.dispatch({
        type: "reviewRoomLoaded",
        taskId: "t1",
        evidence: { taskId: "t1", queue: "q", state: "done", workflow: null, steps: [], artifacts: [], provenance: [] },
        session: null,
        sessionError: null,
      } as never);
    });
    act(() => { mounted = create(React.createElement(ReviewRoomScreen)); });
    expect(appStore.getState().reviewRoom.openTaskId).toBe("t1");

    act(() => fireKeydown({ key: "Escape", target: { tagName: "SELECT" } }));
    expect(appStore.getState().reviewRoom.openTaskId).toBe("t1");

    act(() => fireKeydown({ key: "Escape", target: new TestElement(true) }));
    expect(appStore.getState().reviewRoom.openTaskId).toBe("t1");

    act(() => fireKeydown({ key: "Escape", target: new TestElement() }));
    expect(appStore.getState().reviewRoom.openTaskId).toBeNull();
  });
});

describe("WorkflowStudio — 'n' adds a step only when focus isn't editable (WORKFLOW-STUDIO-INPUT-HIJACK)", () => {
  const DOC = {
    name: "wf", onFail: "halt" as const, retryLimit: 0, params: [],
    nodeOrder: ["a"], nodesById: { a: { id: "a", step: { id: "a", title: "A", gate: { kind: "none" as const } } } },
    edgesById: {},
  };
  afterEach(() => {
    act(() => appStore.dispatch({ type: "workflowStudioClose" } as never));
  });

  it("'n' at a contentEditable target (missed by the old instanceof-only check) is a no-op; at a non-editable target it adds a step", () => {
    act(() => {
      appStore.dispatch({ type: "workflowStudioOpen", mode: "author", document: DOC, queue: null, taskId: null, version: 1 } as never);
    });
    act(() => { mounted = create(React.createElement(WorkflowStudio)); });
    expect(appStore.getState().workflowStudio.draft?.nodeOrder.length).toBe(1);

    act(() => fireKeydown({ key: "n", target: { tagName: "DIV", isContentEditable: true } }));
    expect(appStore.getState().workflowStudio.draft?.nodeOrder.length).toBe(1);

    act(() => fireKeydown({ key: "n", target: NON_EDITABLE }));
    expect(appStore.getState().workflowStudio.draft?.nodeOrder.length).toBe(2);
  });
});

// KEYMAP-REDESIGN: perf hud/pin agent/replay moved off the old dedicated
// ctrl+shift+d/p/r capture-phase listener (App.tsx no longer installs one —
// none of the three is a DESTROY action, so mod+shift+letter was the wrong
// family) onto plain mod+letter rows resolved through the SAME shared
// useHotkeys guard every other row uses. This test now exercises THAT path.
describe("perf hud requires a leader sequence (APP-CHORD-INPUT-HIJACK)", () => {
  it("legacy mod+g does not toggle the HUD; the explicit leader sequence does", async () => {
    function Harness() { useSystemSurfaces(); useHotkeys(appStore); return null; }
    act(() => { mounted = create(React.createElement(Harness)); });
    await act(async () => settle());
    const before = systemLocal.getState().perfHudOpen;
    // chordOf resolves "mod" to the REAL host platform's modifier (no override
    // param here — useHotkeys always uses the live isMacPlatform()), so the
    // synthetic event must send whichever key this test machine actually is.
    const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };

    act(() => fireKeydown({ key: "g", ...mod, target: EDITABLE }));
    expect(systemLocal.getState().perfHudOpen).toBe(before);

    act(() => {
      const e = {ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,repeat:false,target:EDITABLE as unknown as EventTarget,preventDefault:()=>{},stopImmediatePropagation:()=>{}};
      handleDesktopKey({...e,key:"k",...mod},appStore);
      handleDesktopKey({...e,key:"g"},appStore);
    });
    expect(systemLocal.getState().perfHudOpen).toBe(!before);
  });
});
