import * as React from "react";
import { act, create } from "react-test-renderer";
import { describe, it, expect, vi, beforeEach } from "vitest";
const fixture = vi.hoisted(() => ({ connected: true, selectedAgentId: "a", agents: { a: { agentId: "a", displayLabel: "Agent A" }, b: { agentId: "b", displayLabel: "Agent B" } }, listeners: new Set<() => void>(), events: new Set<(e: unknown) => void>() }));
vi.mock("../src/state/store", () => ({ appStore: { getState: () => fixture, subscribe: (fn: () => void) => { fixture.listeners.add(fn); return () => fixture.listeners.delete(fn); } } }));
vi.mock("../src/state/useStore", () => ({ useStore: (fn: (s: unknown) => unknown) => fn(fixture) }));
vi.mock("../src/rpc/bridge", () => ({ rpcCall: vi.fn(), onDaemonEvent: (fn: (e: unknown) => void) => { fixture.events.add(fn); return () => fixture.events.delete(fn); } }));
vi.mock("../src/state/contextLinks", () => ({ openContextShare: vi.fn(), closeContextShare: vi.fn(), useContextShare: () => null, mountContextShareCard: () => () => {} }));
import { ContextLinks } from "../src/components/ContextLinks";
import { ContextLinkShareForm } from "../src/components/ContextLinkShareOverlay";
const link = { id: "6e1c06ab-2032-4cc6-b5c6-1495c7f41e1b", from: { kind: "agent-summary", ref: "a" }, toAgentId: "b", createdBy: "a", createdAt: 100, expiresAt: null, revokedAt: null, snapshot: { title: "Summary", bytes: 4, sha256: "0".repeat(64) }, status: "active", semantics: "snapshot", untrusted: true };
const text = (r: ReturnType<typeof create>) => JSON.stringify(r.toJSON());
const connected = (value: boolean) => { fixture.connected = value; for (const fn of fixture.listeners) fn(); };
beforeEach(() => { fixture.connected = true; fixture.selectedAgentId = "a"; fixture.listeners.clear(); fixture.events.clear(); });
it("pulls only on explicit read and clears private bodies on revoke/disconnect; stale replies never resurrect content", async () => {
  let resolve!: (v: unknown) => void;
  const request = vi.fn((method: string) => method === "contextlink.get" ? new Promise(r => { resolve = r; }) : Promise.resolve({ links: [link] }));
  let r!: ReturnType<typeof create>; act(() => { r = create(<ContextLinks agentId="b" request={request as never} />); }); expect(request).not.toHaveBeenCalled();
  await act(async () => r.root.findByType("details").props.onToggle({ currentTarget: { open: true } }));
  expect(request.mock.calls.every(c => c[0] === "contextlink.list")).toBe(true);
  act(() => r.root.find(n => n.props["data-context-read"] === link.id).props.onClick());
  act(() => connected(false)); await act(async () => resolve({ ...link, snapshot: { ...link.snapshot, text: "PRIVATE" } })); expect(text(r)).not.toContain("PRIVATE");
  await act(async () => connected(true));
  act(() => r.root.find(n => n.props["data-context-read"] === link.id).props.onClick()); await act(async () => resolve({ ...link, snapshot: { ...link.snapshot, text: "PRIVATE" } })); expect(text(r)).toContain("PRIVATE");
  await act(async () => { for (const fn of fixture.events) fn({ kind: "context_link_changed" }); }); expect(text(r)).not.toContain("PRIVATE");
  act(() => r.unmount());
});
it("shows unsupported capability explicitly without a retry loop", async () => {
  const request = vi.fn(async () => { throw { message: "unknown method contextlink.list" }; }); let r!: ReturnType<typeof create>;
  act(() => { r = create(<ContextLinks agentId="b" request={request as never} />); }); await act(async () => r.root.findByType("details").props.onToggle({ currentTarget: { open: true } }));
  expect(text(r)).toContain("unavailable for this daemon"); expect(r.root.findAll(n => n.props["data-load-retry"])).toHaveLength(0); act(() => r.unmount());
});
describe("private note sharing", () => {
  it("previews exact UTF8 bytes, requires secret confirmation and copies only after explicit action", async () => {
    const request = vi.fn(async () => link); let r!: ReturnType<typeof create>;
    act(() => { r = create(<ContextLinkShareForm initial={{ consumer: "b", from: { kind: "note-snapshot", ref: "a" }, text: "sk-secret123 🙂" }} onClose={() => {}} request={request as never} />); });
    expect(request).not.toHaveBeenCalled(); expect(text(r)).toContain("sk-secret123 🙂");
    expect(r.root.find(n => n.props["data-context-share-submit"] !== undefined).props.disabled).toBe(true);
    act(() => r.root.find(n => n.props["aria-label"] === "Confirm sharing secret-shaped content").props.onChange({ target: { checked: true } }));
    act(() => r.root.find(n => n.props["aria-label"] === "Context recipient").props.onChange({ target: { value: "a" } }));
    expect(r.root.find(n => n.props["data-context-share-submit"] !== undefined).props.disabled).toBe(true);
    act(() => r.root.find(n => n.props["aria-label"] === "Context recipient").props.onChange({ target: { value: "b" } }));
    act(() => r.root.find(n => n.props["aria-label"] === "Confirm sharing secret-shaped content").props.onChange({ target: { checked: true } }));
    await act(async () => r.root.find(n => n.props["data-context-share-submit"] !== undefined).props.onClick());
    expect(request).toHaveBeenCalledWith("contextlink.create", expect.objectContaining({ text: "sk-secret123 🙂", confirmSecrets: true, toAgentId: "b" })); act(() => r.unmount());
  });
});
it("native disclosure and button activation keeps browser defaults and stops fleet shortcuts", async () => {
  const { ownContextActivation } = await import("../src/components/contextKeys");
  const stopPropagation = vi.fn(), preventDefault = vi.fn();
  ownContextActivation({ key: " ", target: { closest: () => ({ tagName: "SUMMARY" }) }, stopPropagation, preventDefault } as never);
  expect(stopPropagation).toHaveBeenCalledOnce(); expect(preventDefault).not.toHaveBeenCalled();
  stopPropagation.mockClear(); ownContextActivation({ key: "Enter", ctrlKey: true, target: { closest: () => ({}) }, stopPropagation, preventDefault } as never);
  expect(stopPropagation).not.toHaveBeenCalled();
});

it("agent switching closes the share form synchronously and stale submit cannot share to the old recipient", async () => {
  const request = vi.fn(), close = vi.fn(); let r!: ReturnType<typeof create>;
  act(() => { r = create(<ContextLinkShareForm initial={{ consumer: "b", from: { kind: "note-snapshot", ref: "a" }, text: "frozen preview" }} onClose={close} request={request as never} />); });
  const submit = r.root.find(n => n.props["data-context-share-submit"] !== undefined).props.onClick;
  act(() => { fixture.selectedAgentId = "b"; for (const fn of fixture.listeners) fn(); });
  expect(close).toHaveBeenCalledOnce(); await act(async () => submit()); expect(request).not.toHaveBeenCalled(); act(() => r.unmount());
});
