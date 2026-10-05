import { conversationForkOwnsEscape } from "../src/state/conversationFork";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ForkAgentForm } from "../src/components/ForkAgentOverlay";

const fixture = vi.hoisted(() => ({ state: { activeTab: "agents", selectedAgentId: "a", connected: true }, listeners: new Set<() => void>() }));
vi.mock("../src/state/store", () => ({ appStore: { getState: () => fixture.state, subscribe: (fn: () => void) => { fixture.listeners.add(fn); return () => fixture.listeners.delete(fn); }, dispatch: vi.fn() } }));
vi.mock("../src/state/overlayLifecycle", () => ({ dismissAppLocalOverlays: vi.fn() }));
const caps = { native: { available: false, reason: "New cwd resume is unverified; use snapshot handoff" }, snapshot: { available: true, reason: null }, atSeq: 12, provider: "codex", account: "same-account", model: "same-model" };
const result = { agentId: "child", mode: "snapshot", label: "Snapshot handoff", lineage: { forkedFrom: "a", atSeq: 12, mode: "snapshot" }, worktree: { path: "/child", branch: "child", baseSha: "sha" }, warnings: [] };
let tree: ReturnType<typeof create>;
beforeEach(() => { fixture.state.connected = true; fixture.state.selectedAgentId = "a"; });
afterEach(() => { act(() => tree?.unmount()); expect(fixture.listeners.size).toBe(0); expect(conversationForkOwnsEscape()).toBe(false); });
const field = () => tree.root.findByProps({ "aria-label": "Branch intended task" });
const submit = () => tree.root.find(n => n.props["data-fork-submit"] !== undefined);
it("requires a new task, explains disabled native mode, pins selected boundary and submits exactly once", async () => {
  let finish!: (value: unknown) => void;
  const request = vi.fn((method: string) => method === "agent.forkCapabilities" ? Promise.resolve(caps) : new Promise(resolve => { finish = resolve; }));
  const created = vi.fn();
  await act(async () => { tree = create(<ForkAgentForm agentId="a" upToSeq={12} onClose={() => {}} request={request as never} onCreated={created} />); });
  expect(submit().props.disabled).toBe(true);
  expect(tree.root.findByProps({ value: "native" }).props.disabled).toBe(true);
  expect(JSON.stringify(tree.toJSON())).toContain(caps.native.reason);
  act(() => field().props.onChange({ target: { value: "Inspect another option" } }));
  await act(async () => { submit().props.onClick(); submit().props.onClick(); });
  const calls = request.mock.calls.filter(c => c[0] === "agent.fork"); expect(calls).toHaveLength(1);
  expect(request).toHaveBeenLastCalledWith("agent.fork", expect.objectContaining({ agentId: "a", upToSeq: 12, mode: "snapshot", task: "Inspect another option" }));
  await act(async () => finish(result)); expect(created).toHaveBeenCalledWith("a", "child", "Snapshot handoff"); expect(fixture.state.selectedAgentId).toBe("a");
});
it("retains draft after failure/reconnect and refuses stale capabilities while disconnected", async () => {
  const request = vi.fn(async (method: string) => { if (method === "agent.fork") throw new Error("Creation failed; retry"); return caps; });
  await act(async () => { tree = create(<ForkAgentForm agentId="a" onClose={() => {}} request={request as never} />); });
  act(() => field().props.onChange({ target: { value: "Retained task" } }));
  await act(async () => submit().props.onClick()); expect(field().props.value).toBe("Retained task"); expect(JSON.stringify(tree.toJSON())).toContain("Creation failed");
  act(() => { fixture.state.connected = false; for (const fn of fixture.listeners) fn(); }); expect(submit().props.disabled).toBe(true);
  await act(async () => { fixture.state.connected = true; for (const fn of fixture.listeners) fn(); }); expect(field().props.value).toBe("Retained task"); expect(request.mock.calls.filter(c => c[0] === "agent.forkCapabilities")).toHaveLength(2);
});
it("agent switch closes the form and stale success cannot announce a child against the new selection", async () => {
  let finish!: (value: unknown) => void; const close = vi.fn(), created = vi.fn();
  const request = vi.fn((method: string) => method === "agent.forkCapabilities" ? Promise.resolve(caps) : new Promise(resolve => { finish = resolve; }));
  await act(async () => { tree = create(<ForkAgentForm agentId="a" onClose={close} request={request as never} onCreated={created} />); });
  act(() => field().props.onChange({ target: { value: "inspect" } })); await act(async () => submit().props.onClick());
  act(() => { fixture.state.selectedAgentId = "b"; for (const fn of fixture.listeners) fn(); }); expect(close).toHaveBeenCalledOnce();
  await act(async () => finish(result)); expect(created).not.toHaveBeenCalled();
});
it("unsupported and failed capability loads cannot be presented as successful empty availability", async () => {
  const request = vi.fn(async () => { throw new Error("unknown method agent.forkCapabilities"); });
  await act(async () => { tree = create(<ForkAgentForm agentId="a" onClose={() => {}} request={request as never} />); });
  expect(submit().props.disabled).toBe(true); expect(JSON.stringify(tree.toJSON())).toContain("Update it or create a fresh agent");
});
