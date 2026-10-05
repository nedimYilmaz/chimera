vi.mock("../src/voice/localStt", () => ({ useLocalStt: () => ({ appleLocales: [] }) }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

type Listener = () => void;
const windowListeners = new Map<string, Set<Listener>>();
const documentListeners = new Map<string, Set<Listener>>();
const mockDocument = {
  hidden: false,
  addEventListener(type: string, listener: Listener) {
    const listeners = documentListeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    documentListeners.set(type, listeners);
  },
  removeEventListener(type: string, listener: Listener) { documentListeners.get(type)?.delete(listener); },
};

(globalThis as unknown as { window: unknown }).window = {
  addEventListener(type: string, listener: Listener) {
    const listeners = windowListeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    windowListeners.set(type, listeners);
  },
  removeEventListener(type: string, listener: Listener) { windowListeners.get(type)?.delete(listener); },
};
(globalThis as unknown as { document: unknown }).document = mockDocument;

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

const session = vi.hoisted(() => ({
  busy: false,
  cancel: vi.fn(),
  start: vi.fn(),
  stopAndSend: vi.fn(),
  stopSpeaking: vi.fn(),
}));

vi.mock("../src/voice/session", () => ({
  cancelPushToTalk: session.cancel,
  isPushToTalkBusy: () => session.busy,
  startPushToTalk: session.start,
  stopPushToTalkAndInsert: session.stopAndSend,
  stopSpeakingNow: session.stopSpeaking,
}));

import { PushToTalkControl } from "../src/components/PushToTalkControl";
import { appStore } from "../src/state/store";
import { voiceLocal } from "../src/voice/store";

function fire(listeners: Map<string, Set<Listener>>, type: string): void {
  for (const listener of listeners.get(type) ?? []) listener();
}

function mount(agentId: string | null = "a1", onSend = vi.fn()): { root: ReactTestRenderer; button: () => ReactTestInstance } {
  let root!: ReactTestRenderer;
  act(() => { root = create(<PushToTalkControl agentId={agentId} onInsert={onSend} />); });
  return { root, button: () => root.root.findByProps({ "data-push-to-talk": true }) };
}

function keyEvent(key: string, repeat = false) {
  return { key, repeat, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

function pointerEvent(pointerId = 1, options: { button?: number; isPrimary?: boolean; pointerType?: string; x?: number; y?: number } = {}) {
  const capture = new Set<number>();
  const currentTarget = {
    setPointerCapture: vi.fn((id: number) => capture.add(id)),
    hasPointerCapture: vi.fn((id: number) => capture.has(id)),
    releasePointerCapture: vi.fn((id: number) => capture.delete(id)),
    getBoundingClientRect: () => ({ left: 0, right: 10, top: 0, bottom: 10 }),
  };
  return {
    pointerId,
    button: options.button ?? 0,
    isPrimary: options.isPrimary ?? true,
    pointerType: options.pointerType ?? "mouse",
    clientX: options.x ?? 5,
    clientY: options.y ?? 5,
    currentTarget,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe("PushToTalkControl focused gesture ownership", () => {
  it("mounts when a non-browser document stub has no event listener methods", () => {
    const previousDocument = globalThis.document;
    (globalThis as unknown as { document: unknown }).document = { hidden: false };
    let root: ReactTestRenderer | undefined;
    try {
      expect(() => {
        act(() => { root = create(<PushToTalkControl agentId="a1" onInsert={() => {}} />); });
      }).not.toThrow();
    } finally {
      if (root) act(() => root.unmount());
      (globalThis as unknown as { document: unknown }).document = previousDocument;
    }
  });

  it("Q14 does not cancel a conversation that starts while the control is mounted", () => {
    const current = mount("a1");
    try {
      expect(session.cancel).not.toHaveBeenCalled();
      session.busy = true;
      act(() => { voiceLocal.dispatch({ type: "conversationStarted", sessionId: "q14-conversation", agentId: "a1" }); });
      expect(session.cancel).not.toHaveBeenCalled();
    } finally { act(() => current.root.unmount()); }
  });

  beforeEach(() => {
    session.busy = false;
    session.cancel.mockReset().mockImplementation(() => { session.busy = false; });
    session.start.mockReset().mockImplementation(() => { session.busy = true; return Promise.resolve(); });
    session.stopAndSend.mockReset().mockImplementation(() => { session.busy = false; return Promise.resolve(); });
    session.stopSpeaking.mockReset().mockReturnValue(true);
    mockDocument.hidden = false;
    appStore.dispatch({ type: "connected", connected: true });
    voiceLocal.dispatch({ type: "idle" });
  });

  afterEach(() => {
    voiceLocal.dispatch({ type: "idle" });
    windowListeners.clear();
    documentListeners.clear();
  });

  it.each([[" ", "Space"], ["Enter", "Enter"]] as const)("holds %s from first keydown to matching keyup exactly once", (key, normalized) => {
    const { root, button } = mount();
    const down = keyEvent(key);
    act(() => { button().props.onKeyDown(down); });
    expect(session.start).toHaveBeenCalledTimes(1);
    expect(session.start).toHaveBeenCalledWith("a1");
    expect(down.preventDefault).toHaveBeenCalledTimes(1);
    expect(down.stopPropagation).toHaveBeenCalledTimes(1);

    act(() => { voiceLocal.dispatch({ type: "sessionStarted", sessionId: "s1", agentId: "a1" }); });
    act(() => { button().props.onKeyDown(keyEvent(key, true)); });
    act(() => { button().props.onKeyUp(keyEvent(normalized)); });
    act(() => { button().props.onClick(keyEvent("click")); });
    act(() => { button().props.onKeyUp(keyEvent(normalized)); });

    expect(session.start).toHaveBeenCalledTimes(1);
    expect(session.stopAndSend).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("cancels a key release while capture start is pending and never sends", () => {
    const { root, button } = mount();
    act(() => { button().props.onKeyDown(keyEvent(" ")); });
    expect(session.busy).toBe(true);
    act(() => { button().props.onKeyUp(keyEvent(" ")); });
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(session.stopAndSend).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it.each(["mouse", "touch", "pen"])("uses the single primary-pointer path for %s", (pointerType) => {
    const { root, button } = mount();
    const down = pointerEvent(1, { pointerType });
    act(() => { button().props.onPointerDown(down); });
    expect(session.start).toHaveBeenCalledTimes(1);
    expect(down.currentTarget.setPointerCapture).toHaveBeenCalledWith(1);
    act(() => { voiceLocal.dispatch({ type: "sessionStarted", sessionId: "s1", agentId: "a1" }); });
    const up = { ...pointerEvent(1, { pointerType }), currentTarget: down.currentTarget };
    act(() => { button().props.onPointerUp(up); });
    expect(session.stopAndSend).toHaveBeenCalledTimes(1);
    expect(down.currentTarget.releasePointerCapture).toHaveBeenCalledWith(1);
    act(() => root.unmount());
  });

  it("ignores secondary, non-primary, unrelated and overlapping pointers", () => {
    const { root, button } = mount();
    act(() => { button().props.onPointerDown(pointerEvent(1, { button: 2 })); });
    act(() => { button().props.onPointerDown(pointerEvent(1, { isPrimary: false })); });
    expect(session.start).not.toHaveBeenCalled();

    const owned = pointerEvent(3);
    act(() => { button().props.onPointerDown(owned); });
    act(() => { button().props.onKeyDown(keyEvent("Enter")); });
    act(() => { button().props.onPointerUp(pointerEvent(9)); });
    expect(session.start).toHaveBeenCalledTimes(1);
    expect(session.stopAndSend).not.toHaveBeenCalled();
    expect(session.cancel).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(session.cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["outside release", "pointer cancel", "lost capture", "element blur", "window blur", "hidden page", "unmount"])("cancels once on %s", (reason) => {
    const { root, button } = mount();
    const down = pointerEvent();
    act(() => { button().props.onPointerDown(down); });
    const trigger = () => {
      if (reason === "outside release") button().props.onPointerUp({ ...pointerEvent(1, { x: 20 }), currentTarget: down.currentTarget });
      else if (reason === "pointer cancel") button().props.onPointerCancel({ ...pointerEvent(), currentTarget: down.currentTarget });
      else if (reason === "lost capture") button().props.onLostPointerCapture({ ...pointerEvent(), currentTarget: down.currentTarget });
      else if (reason === "element blur") button().props.onBlur();
      else if (reason === "window blur") fire(windowListeners, "blur");
      else if (reason === "hidden page") { mockDocument.hidden = true; fire(documentListeners, "visibilitychange"); }
      else root.unmount();
    };
    act(trigger);
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(session.stopAndSend).not.toHaveBeenCalled();
    if (reason !== "unmount") {
      act(trigger);
      expect(session.cancel).toHaveBeenCalledTimes(1);
      act(() => root.unmount());
    }
  });

  it("invalidates transcription on agent switch and disconnect", () => {
    const first = mount("a1");
    session.busy = true;
    act(() => { voiceLocal.dispatch({ type: "transcribing" }); });
    act(() => { first.root.update(<PushToTalkControl agentId="a2" onInsert={() => {}} />); });
    expect(session.cancel).toHaveBeenCalledTimes(1);
    act(() => first.root.unmount());

    session.cancel.mockClear();
    session.busy = true;
    const second = mount("a1");
    act(() => { appStore.dispatch({ type: "connected", connected: false }); });
    expect(session.cancel).toHaveBeenCalledTimes(1);
    act(() => second.root.unmount());
  });

  it("stops speaking once for pointer and keyboard without starting or sending on release", () => {
    act(() => { voiceLocal.dispatch({ type: "speaking", text: "reply" }); });
    const { root, button } = mount(null);
    expect(button().props.disabled).toBe(false);

    const pointer = pointerEvent();
    act(() => { button().props.onPointerDown(pointer); });
    act(() => { button().props.onPointerDown(pointerEvent(2)); });
    act(() => { button().props.onPointerUp({ ...pointerEvent(), currentTarget: pointer.currentTarget }); });
    act(() => { button().props.onClick(keyEvent("click")); });
    expect(session.stopSpeaking).toHaveBeenCalledTimes(1);

    act(() => { button().props.onKeyDown(keyEvent("Enter")); });
    act(() => { button().props.onKeyDown(keyEvent("Enter", true)); });
    act(() => { button().props.onKeyUp(keyEvent("Enter")); });
    expect(session.stopSpeaking).toHaveBeenCalledTimes(2);
    expect(session.start).not.toHaveBeenCalled();
    expect(session.stopAndSend).not.toHaveBeenCalled();
    expect(button().props.title).toContain("Space or Enter");
    act(() => root.unmount());
  });

  it("preserves a conversation that starts while the PTT control is mounted", () => {
    const { root, button } = mount("a1");
    const idleBlur = button().props.onBlur;
    session.busy = true;
    act(() => {
      voiceLocal.dispatch({ type: "conversationStarted", sessionId: "conversation-new", agentId: "a1" });
    });
    expect(session.cancel).not.toHaveBeenCalled();
    act(() => {
      idleBlur();
      fire(windowListeners, "blur");
      mockDocument.hidden = true;
      fire(documentListeners, "visibilitychange");
      root.update(<PushToTalkControl agentId="a2" onInsert={() => {}} />);
    });
    act(() => root.unmount());
    expect(session.cancel).not.toHaveBeenCalled();
    expect(session.stopAndSend).not.toHaveBeenCalled();
    expect(voiceLocal.getState().sessionId).toBe("conversation-new");
    expect(voiceLocal.getState().conversationActive).toBe(true);
  });

  it("guards disabled, disconnected and conversation-active starts", () => {
    const missing = mount(null);
    expect(missing.button().props.disabled).toBe(true);
    act(() => { missing.button().props.onKeyDown(keyEvent("Enter")); });
    expect(session.start).not.toHaveBeenCalled();
    act(() => missing.root.unmount());

    appStore.dispatch({ type: "connected", connected: false });
    const disconnected = mount("a1");
    expect(disconnected.button().props.disabled).toBe(true);
    act(() => { disconnected.button().props.onPointerDown(pointerEvent()); });
    expect(session.start).not.toHaveBeenCalled();
    act(() => disconnected.root.unmount());

    appStore.dispatch({ type: "connected", connected: true });
    act(() => { voiceLocal.dispatch({ type: "conversationStarted", sessionId: "c1", agentId: "a1" }); });
    const conversation = mount("a1");
    session.busy = true;
    act(() => { conversation.button().props.onKeyDown(keyEvent("Enter")); });
    expect(session.start).not.toHaveBeenCalled();
    act(() => { fire(windowListeners, "blur"); });
    expect(session.cancel).not.toHaveBeenCalled();
    act(() => conversation.root.unmount());
  });
});

it("Escape on the focused mic cancels dictation and prevents insertion", () => {
  session.cancel.mockClear(); session.stopAndSend.mockClear();
  appStore.dispatch({ type: "connected", connected: true }); voiceLocal.dispatch({ type: "idle" });
  const control = mount(); session.busy = true;
  act(() => voiceLocal.dispatch({ type: "sessionStarted", sessionId: "dictation", agentId: "a1" }));
  const event = keyEvent("Escape"); act(() => control.button().props.onKeyDown(event));
  expect(session.cancel).toHaveBeenCalledOnce(); expect(session.stopAndSend).not.toHaveBeenCalled(); expect(event.stopPropagation).toHaveBeenCalled();
  session.busy = false; act(() => control.root.unmount());
});
