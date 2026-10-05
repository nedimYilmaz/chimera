import { afterEach, expect, it, vi } from "vitest";
import { act, create } from "react-test-renderer";
import * as React from "react";
import type { OperatorWebSnapshot } from "@chimera/protocol";
import { OperatorPanel } from "../src/operator/OperatorPanel";
import { SessionExpired, type OperatorTransport } from "../src/operator/bridge";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const data: OperatorWebSnapshot = { project: "one", scope: "control", agents: ["a", "b"].map(id => ({ agentId: id, label: `Worker ${id}`, state: "running", held: false })), queues: [], attention: [], truncated: false };
function fixture() {
  let changed = () => {}, interrupted = () => {};
  const transport = {
    restore: vi.fn(async () => ({ csrf: "csrf", project: "one", scope: "control" as const, expiresAt: Date.now() + 3600000 })), pair: vi.fn(),
    snapshot: vi.fn(async () => data), rpc: vi.fn(async (method: string, params: { agentId: string }) => method === "agent.tail" ? [{ seq: 1, kind: "message_delta", text: `Tail ${params.agentId}` }] : { ok: true }), logout: vi.fn(),
    events: vi.fn((c: () => void, i: () => void) => { changed = c; interrupted = i; return () => {}; }),
  };
  return { transport, change: () => changed(), interrupt: () => interrupted() };
}
let view: ReturnType<typeof create> | undefined;
afterEach(() => { if (view) act(() => view!.unmount()); view = undefined; });
const mount = async (transport: unknown) => { await act(async () => { view = create(<OperatorPanel transport={transport as OperatorTransport} />); }); };
const button = (text: string) => view!.root.findAllByType("button").find(b => b.children.join("") === text)!;
const select = async (id: string) => { await act(async () => { button(`Worker ${id}`).props.onClick(); }); };
const renderedText = () => JSON.stringify(view!.toJSON());
it("prevents selection changes during a pending tail and preserves each agent's draft", async () => {
  const f = fixture(), tail = defer<unknown>(); f.transport.rpc.mockImplementationOnce(() => tail.promise as never);
  await mount(f.transport);
  await act(async () => { button("Worker a").props.onClick(); });
  expect(button("Worker b").props.disabled).toBe(true);
  await act(async () => { button("Worker b").props.onClick(); tail.resolve([{ seq: 1, kind: "message_delta", text: "Tail a" }]); });
  expect(view!.root.findByProps({ "aria-label": "Agent tail" }).findByType("h3").children.join("")).toContain("Worker a");
  await act(async () => { view!.root.findByType("textarea").props.onChange({ target: { value: "Draft for a" } }); });
  await select("b"); expect(view!.root.findByType("textarea").props.value).toBe("");
  await act(async () => { view!.root.findByType("textarea").props.onChange({ target: { value: "Draft for b" } }); });
  await select("a"); expect(view!.root.findByType("textarea").props.value).toBe("Draft for a");
});
it("drops a pending snapshot after session revoke and clears private text", async () => {
  const f = fixture(), snapshot = defer<OperatorWebSnapshot>(); f.transport.snapshot.mockImplementationOnce(() => snapshot.promise);
  await mount(f.transport); f.transport.restore.mockRejectedValueOnce(new SessionExpired());
  await act(async () => { f.interrupt(); });
  await act(async () => { snapshot.resolve(data); });
  expect(view!.root.findAllByProps({ "data-operator-code": true })).toHaveLength(1);
  expect(renderedText()).not.toContain("Worker a"); expect(renderedText()).toContain("expired or revoked");
});
it("coalesces changes during a pending snapshot into one trailing refresh", async () => {
  const f = fixture(), snapshot = defer<OperatorWebSnapshot>(); f.transport.snapshot.mockImplementationOnce(() => snapshot.promise);
  f.transport.snapshot.mockResolvedValueOnce({ ...data, agents: [{ ...data.agents[0]!, label: "Newest worker" }] });
  await mount(f.transport);
  await act(async () => { f.change(); f.change(); snapshot.resolve(data); });
  expect(f.transport.snapshot).toHaveBeenCalledTimes(2); expect(renderedText()).toContain("Newest worker");
});
it("stream rejection has explicit reconnect and never opens a retry loop", async () => {
  const f = fixture(); await mount(f.transport);
  await act(async () => { f.interrupt(); });
  expect(f.transport.restore).toHaveBeenCalledTimes(2); expect(f.transport.events).toHaveBeenCalledTimes(1); expect(renderedText()).toContain("Use Refresh to reconnect");
  await act(async () => { button("Refresh").props.onClick(); });
  expect(f.transport.events).toHaveBeenCalledTimes(2);
});
it("double submit sends only once and clears only the successfully sent draft", async () => {
  const f = fixture(); await mount(f.transport); await select("a");
  await act(async () => { view!.root.findByType("textarea").props.onChange({ target: { value: "Review before send" } }); });
  const send = defer<unknown>(); f.transport.rpc.mockImplementationOnce(() => send.promise as never);
  const form = view!.root.findByType("form");
  await act(async () => { form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} }); });
  expect(f.transport.rpc.mock.calls.filter(c => c[0] === "agent.send")).toHaveLength(1);
  await act(async () => { send.resolve({ ok: true }); });
  expect(view!.root.findByType("textarea").props.value).toBe("");
});
it("renders readable review findings and makes review decisions explicit", async () => {
  const f = fixture(); f.transport.snapshot.mockResolvedValue({ ...data, queues: [{ name: "q", paused: true, tasks: [{ taskId: "t", prompt: "Review synthetic task", state: "done" }] }] });
  f.transport.rpc.mockImplementation(async () => ({ taskId: "t", findings: [], decision: null, revision: 0, updatedAt: 0 }) as never);
  await mount(f.transport);
  await act(async () => { button("Review").props.onClick(); });
  await act(async () => { button("Review synthetic task").props.onClick(); });
  expect(renderedText()).toContain("Awaiting decision"); expect(renderedText()).toContain("No findings"); expect(renderedText()).not.toContain('"revision"');
  expect(button("Record review decision").props.disabled).toBe(true);
  const fields = view!.root.findAllByType("textarea");
  await act(async () => { fields[fields.length - 1]!.props.onChange({ target: { value: "Please address the regression" } }); });
  const forms = view!.root.findAllByType("form");
  await act(async () => { forms[forms.length - 1]!.props.onSubmit({ preventDefault() {} }); });
  expect(f.transport.rpc).toHaveBeenCalledWith("review.decide", { taskId: "t", status: "changes_requested", summary: "Please address the regression" });
});
it("labels held delivery as queued instead of claiming delivery", async () => {
  const f = fixture(); await mount(f.transport); await select("a");
  await act(async () => { view!.root.findByType("textarea").props.onChange({ target: { value: "Hold this message" } }); });
  f.transport.rpc.mockResolvedValueOnce({ ack: "held", delivered: false } as never);
  await act(async () => { view!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  expect(renderedText()).toContain("Message queued while the agent is paused");
});
it("clears a view when another tab replaces the cookie's project or scope", async () => {
  const f = fixture(); await mount(f.transport);
  f.transport.snapshot.mockResolvedValueOnce({ ...data, project: "another-project", scope: "read", agents: [{ ...data.agents[0]!, label: "Foreign worker" }] });
  await act(async () => { f.change(); });
  expect(renderedText()).toContain("Browser session changed"); expect(renderedText()).not.toContain("Foreign worker");
  expect(view!.root.findAllByProps({ "data-operator-code": true })).toHaveLength(1);
});
