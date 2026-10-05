import * as React from "react";
import { create, act } from "react-test-renderer";
import { openContextShare, closeContextShare, mountContextShareCard, contextShareOwnsEscape } from "../src/state/contextLinks";
import { OverlayOutlet } from "../src/components/OverlayOutlet";
import "../src/components/ContextLinkShareOverlay";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  state: { activeTab: "agents", selectedAgentId: "a", connected: true, agents: { a: { agentId: "a", displayLabel: "Agent A" }, b: { agentId: "b", displayLabel: "Agent B" } } },
  listeners: new Set<() => void>(), request: vi.fn(),
}));
vi.mock("../src/state/store", () => ({ appStore: { getState: () => fixture.state, subscribe: (fn: () => void) => { fixture.listeners.add(fn); return () => fixture.listeners.delete(fn); } } }));
vi.mock("../src/rpc/bridge", () => ({ rpcCall: fixture.request }));
vi.mock("../src/state/overlayLifecycle", () => ({ dismissAppLocalOverlays: vi.fn() }));
let rendered: ReturnType<typeof create> | undefined;
beforeEach(() => { fixture.request.mockReset(); });
afterEach(() => { act(() => { closeContextShare(); rendered?.unmount(); }); rendered = undefined; expect(contextShareOwnsEscape()).toBe(false); expect(fixture.listeners.size).toBe(0); });
const open = (recipient: "a" | "b", text: string) => openContextShare({ consumer: recipient, from: { kind: "note-snapshot", ref: recipient }, text });
const field = (label: string) => rendered!.root.find(n => n.props["aria-label"] === label);
const submit = () => rendered!.root.find(n => n.props["data-context-share-submit"] !== undefined);
const snapshot = (recipient: "a" | "b") => ({
  id: "6e1c06ab-2032-4cc6-b5c6-1495c7f41e1b", from: { kind: "note-snapshot", ref: recipient }, toAgentId: recipient,
  createdBy: "operator", createdAt: 100, expiresAt: null, revokedAt: null,
  snapshot: { title: "Snapshot", bytes: 4, sha256: "0".repeat(64) }, status: "active", semantics: "snapshot", untrusted: false,
});
it("share Escape ownership releases on every cleanup and survives overlapping StrictMode lifetimes", () => {
  expect(contextShareOwnsEscape()).toBe(false);
  const release = mountContextShareCard(), replacement = mountContextShareCard();
  release(); release(); expect(contextShareOwnsEscape()).toBe(true);
  replacement(); expect(contextShareOwnsEscape()).toBe(false);
  const remount = mountContextShareCard(); expect(contextShareOwnsEscape()).toBe(true);
  remount(); expect(contextShareOwnsEscape()).toBe(false);
});

it("replacing a registered share reinitializes its exact source and recipient", () => {
  act(() => { rendered = create(React.createElement(OverlayOutlet, { host: "agents" })); open("a", "first preview"); });
  expect(field("Context recipient").props.value).toBe("a");
  act(() => open("b", "replacement preview"));
  expect(field("Context recipient").props.value).toBe("b");
  expect(JSON.stringify(rendered!.toJSON())).toContain("replacement preview");
});

it.each(["success", "failure"])("stale A %s cannot overwrite or dismiss B; B edits survive store refresh and submit the exact payload", async outcome => {
  let resolveA!: (result: unknown) => void, rejectA!: (error: unknown) => void, resolveB!: (result: unknown) => void;
  fixture.request.mockImplementationOnce(() => new Promise((resolve, reject) => { resolveA = resolve; rejectA = reject; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve; }));
  act(() => { rendered = create(React.createElement(OverlayOutlet, { host: "agents" })); open("a", "exact A preview"); });
  act(() => submit().props.onClick());
  expect(fixture.request).toHaveBeenNthCalledWith(1, "contextlink.create", expect.objectContaining({ toAgentId: "a", text: "exact A preview" }));
  act(() => open("b", "exact B preview 🙂"));
  act(() => {
    field("Context title").props.onChange({ target: { value: "B unsaved title" } });
    rendered!.root.findAllByType("input").find(n => n.props.type === "checkbox")!.props.onChange({ target: { checked: true } });
  });
  const refresh = () => {
    fixture.state = { ...fixture.state, agents: { ...fixture.state.agents, b: { ...fixture.state.agents.b, displayLabel: "B refreshed record" } } };
    for (const fn of fixture.listeners) fn();
  };
  act(refresh);
  expect(field("Context recipient").props.value).toBe("b");
  expect(field("Context title").props.value).toBe("B unsaved title");
  expect(rendered!.root.find(n => n.props["data-context-note-preview"] !== undefined).children).toEqual(["exact B preview 🙂"]);
  await act(async () => { if (outcome === "success") resolveA(snapshot("a")); else rejectA({ code: "transport", message: "Old A request failed" }); });
  expect(contextShareOwnsEscape()).toBe(true);
  expect(rendered!.root.findAll(n => n.props["data-context-share"] !== undefined)).toHaveLength(1);
  expect(field("Context recipient").props.value).toBe("b");
  expect(field("Context title").props.value).toBe("B unsaved title");
  expect(JSON.stringify(rendered!.toJSON())).not.toMatch(/Snapshot shared|Sharing failed|Old A request failed/);
  act(() => submit().props.onClick());
  expect(fixture.request).toHaveBeenNthCalledWith(2, "contextlink.create", expect.objectContaining({
    from: { kind: "note-snapshot", ref: "b" }, toAgentId: "b", text: "exact B preview 🙂", title: "B unsaved title", notify: true, confirmSecrets: false,
  }));
  expect(field("Context recipient").props.disabled).toBe(true);
  act(refresh);
  expect(field("Context title").props.value).toBe("B unsaved title");
  await act(async () => resolveB(snapshot("b")));
  expect(JSON.stringify(rendered!.toJSON())).toContain("Snapshot shared");
  expect(field("Context recipient").props.value).toBe("b");
});
