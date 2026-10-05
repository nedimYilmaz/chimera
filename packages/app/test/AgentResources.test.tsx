import * as React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const connection = vi.hoisted(() => ({ connected: true, listeners: new Set<() => void>() }));
vi.mock("../src/state/store", () => ({ appStore: { getState: () => connection, subscribe: (fn: () => void) => { connection.listeners.add(fn); return () => connection.listeners.delete(fn); } } }));
vi.mock("../src/rpc/bridge", () => ({ rpcCall: vi.fn() }));
import { resourceSamplerOwnerCount } from "../src/state/agentResources";
import { TranscriptHeader } from "../src/components/TranscriptHeader";
import { AgentResources } from "../src/components/AgentResources";
import type { AgentResourcesResponse } from "@chimera/protocol";
const fixture = (): AgentResourcesResponse => ({
  sample: { agentId: "a", sampledAt: Date.now(), state: "ok", rootPid: 10, procs: Array.from({ length: 300 }, (_, i) => ({ pid: 10 + i, ppid: i ? 10 : 1, name: "node", role: i ? "tool" : "agent", cpuPct: null, rssBytes: 1024 ** 2, elapsedSec: 60 })), totals: { cpuPct: null, rssBytes: 300 * 1024 ** 2, procCount: 300 }, truncated: false },
  admission: { cap: 6, ceiling: 8, running: 6, healthy: true, cpuPressure: true, memPressure: false, load1: 8, cores: 8, freeMemGb: 3, explain: "load 8/8 cores, 3 GB free" },
});
const text = (r: ReturnType<typeof create>) => JSON.stringify(r.toJSON());
async function open(r: ReturnType<typeof create>) { await act(async () => r.root.findByProps({ "data-agent-resources": true }).props.onToggle({ currentTarget: { open: true } })); }
function changeConnection(value: boolean) { connection.connected = value; for (const fn of connection.listeners) fn(); }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
beforeEach(() => { connection.connected = true; connection.listeners.clear(); });
describe("Resources disclosure", () => {
  it("loads only when open, bounds rendered rows and distinguishes OS memory from token context", async () => {
    const request = vi.fn(async () => fixture()); let r!: ReturnType<typeof create>;
    act(() => { r = create(<AgentResources agentId="a" request={request as never} />); });
    expect(request).not.toHaveBeenCalled(); await open(r);
    expect(text(r)).toContain("300 procs"); expect(text(r)).toContain("separate from token context");
    expect(text(r)).toContain("new agents wait for capacity");
    expect(r.root.findAll(n => n.props.title?.includes("PID"))).toHaveLength(14);
    act(() => r.unmount());
  });
  it("retains last-good data and rejects late pre-disconnect replies on reconnect", async () => {
    const pending: { resolve: (data: AgentResourcesResponse) => void }[] = [];
    const request = vi.fn(() => new Promise<AgentResourcesResponse>(resolve => pending.push({ resolve })));
    let r!: ReturnType<typeof create>; act(() => { r = create(<AgentResources agentId="a" request={request as never} />); });
    await open(r); await act(async () => pending[0]!.resolve(fixture()));
    act(() => { changeConnection(false); changeConnection(true); });
    expect(request).toHaveBeenCalledTimes(2);
    act(() => changeConnection(false));
    await act(async () => pending[1]!.resolve({ ...fixture(), sample: { ...fixture().sample, totals: { procCount: 999, cpuPct: 9, rssBytes: 9 } } }));
    expect(text(r)).toContain("300 procs"); expect(text(r)).not.toContain("999 procs"); expect(text(r)).toContain("stale");
    act(() => changeConnection(true)); await act(async () => pending[2]!.resolve(fixture()));
    expect(r.root.findAll(n => n.props["data-load-status"] === "stale")).toHaveLength(0);
    act(() => r.unmount());
  });
  it("restores visible rows after a scrolled tree becomes unavailable and recovers", async () => {
    const unavailable = fixture();
    unavailable.sample = { ...unavailable.sample, state: "unavailable", reason: "no_process", rootPid: null, procs: [], totals: { cpuPct: null, rssBytes: null, procCount: 0 } };
    const request = vi.fn().mockResolvedValueOnce(fixture()).mockResolvedValueOnce(unavailable).mockResolvedValueOnce(fixture());
    let r!: ReturnType<typeof create>; act(() => { r = create(<AgentResources agentId="a" request={request as never} />); });
    await open(r);
    act(() => r.root.find(n => n.props["data-resource-tree"] !== undefined).props.onScroll({ currentTarget: { scrollTop: 8000 } }));
    await act(async () => { changeConnection(false); changeConnection(true); });
    expect(r.root.findAll(n => n.props["data-resource-tree"] !== undefined)).toHaveLength(0);
    await act(async () => { changeConnection(false); changeConnection(true); });
    expect(r.root.findAll(n => n.props.title?.includes("PID"))[0]?.props.title).toContain("PID 10 ·");
    act(() => r.unmount());
  });
  it("shows unsupported capability without a retry loop", async () => {
    const request = vi.fn(async () => { throw { code: "protocol", message: "unknown method agent.resources" }; });
    let r!: ReturnType<typeof create>; act(() => { r = create(<AgentResources agentId="a" request={request as never} />); }); await open(r);
    expect(text(r)).toContain("this daemon does not support"); expect(r.root.findAll(n => n.props["data-load-retry"])).toHaveLength(0);
    act(() => r.unmount());
  });
});

const header = (agentId: string, request: unknown) => <TranscriptHeader name="selected" fullId={agentId} state="running" tone="success" overBudget={false}
  costUsd={1} usageTotal={100} fullContext={100} limit={1000} ring={[]} hint={{ above: 0, below: 0 }}
  detailOpen={false} onToggleDetail={() => {}} onAction={() => {}} resourceAgentId={agentId} resourceRequest={request as never} />;

describe("Selected header resource sampler", () => {
  it("shares header and inspector requests, waits for CPU delta, and stops after last consumer", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => fixture()); let h!: ReturnType<typeof create>; let r!: ReturnType<typeof create>;
    await act(async () => { h = create(header("a", request)); r = create(<AgentResources agentId="a" request={request as never} />); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(h.root.findByProps({ "data-resource-summary": true }).findAllByType("span").some(s => s.children.join("").includes("CPU measuring"))).toBe(true);
    expect(text(h)).toContain("300 MiB");
    await open(r); expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(5000); }); expect(request).toHaveBeenCalledTimes(2);
    act(() => h.unmount());
    await act(async () => { vi.advanceTimersByTime(5000); }); expect(request).toHaveBeenCalledTimes(3);
    act(() => r.unmount());
    await act(async () => { vi.advanceTimersByTime(20000); }); expect(request).toHaveBeenCalledTimes(3);
  });
  it("isolates agent switches and rejects old agent and pre-reconnect replies", async () => {
    const pending: { id: string; resolve: (data: AgentResourcesResponse) => void }[] = [];
    const request = vi.fn((_method, params) => new Promise<AgentResourcesResponse>(resolve => pending.push({ id: params.agentId, resolve })));
    let h!: ReturnType<typeof create>; act(() => { h = create(header("a", request)); });
    act(() => h.update(header("b", request)));
    await act(async () => pending[0]!.resolve(fixture()));
    expect(text(h)).not.toContain("300 MiB"); expect(pending.map(p => p.id)).toEqual(["a", "b"]);
    act(() => { changeConnection(false); changeConnection(true); });
    await act(async () => pending[1]!.resolve({ ...fixture(), sample: { ...fixture().sample, agentId: "b" } }));
    expect(text(h)).not.toContain("300 MiB");
    await act(async () => pending[2]!.resolve({ ...fixture(), sample: { ...fixture().sample, agentId: "b", totals: { procCount: 1, rssBytes: 1024 ** 2, cpuPct: 150 } } }));
    expect(text(h)).toContain("150.0%"); expect(text(h)).toContain("1 MiB");
    act(() => changeConnection(false));
    expect(h.root.findByProps({ "data-resource-summary": true }).props["data-resource-state"]).toBe("stale");
    expect(text(h)).toContain("disconnected"); act(() => h.unmount());
  });
  it("pauses on hidden documents, discards a late sample, and resumes once visible", async () => {
    vi.useFakeTimers();
    const events = new EventTarget(); const doc = { visibilityState: "visible", addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
    vi.stubGlobal("document", doc);
    const pending: ((data: AgentResourcesResponse) => void)[] = [];
    const request = vi.fn(() => new Promise<AgentResourcesResponse>(resolve => pending.push(resolve)));
    let h!: ReturnType<typeof create>; act(() => { h = create(header("a", request)); });
    act(() => { doc.visibilityState = "hidden"; events.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { pending[0]!(fixture()); vi.advanceTimersByTime(30000); });
    expect(request).toHaveBeenCalledTimes(1); expect(text(h)).not.toContain("300 MiB");
    act(() => { doc.visibilityState = "visible"; events.dispatchEvent(new Event("visibilitychange")); });
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => pending[1]!(fixture())); expect(text(h)).toContain("300 MiB"); act(() => h.unmount());
  });
  it("shows no_process and partial samples honestly without fake zero measurements", async () => {
    const unavailable = fixture(); unavailable.sample = { ...unavailable.sample, state: "unavailable", reason: "no_process", procs: [], rootPid: null, totals: { cpuPct: null, rssBytes: null, procCount: 0 } };
    const request = vi.fn().mockResolvedValueOnce(unavailable).mockResolvedValueOnce({ ...fixture(), sample: { ...fixture().sample, truncated: true } });
    let h!: ReturnType<typeof create>; await act(async () => { h = create(header("a", request)); });
    expect(h.root.findByProps({ "data-resource-summary": true }).props["data-resource-state"]).toBe("unavailable");
    expect(text(h)).not.toContain("0 MiB");
    await act(async () => h.root.findByType("details").props.onToggle({ currentTarget: { open: true } }));
    expect(text(h)).toContain("transport hides PID");
    await act(async () => { changeConnection(false); changeConnection(true); }); expect(text(h)).toContain("partial");
    expect(text(h)).toContain("100% equals one CPU core"); act(() => h.unmount());
  });
});

describe("Resource owner lifetime", () => {
  it("evicts historical agents across many switches and final unmount, dropping late replies", async () => {
    vi.useFakeTimers();
    const pending: ((data: AgentResourcesResponse) => void)[] = [];
    const request = vi.fn(() => new Promise<AgentResourcesResponse>(resolve => pending.push(resolve)));
    let h!: ReturnType<typeof create>; act(() => { h = create(header("a", request)); });
    for (let i = 0; i < 100; i++) {
      act(() => h.update(header(`switch-${i}`, request)));
      expect(resourceSamplerOwnerCount(request as never)).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
    }
    await act(async () => pending[0]!(fixture())); expect(text(h)).not.toContain("300 MiB");
    act(() => h.unmount());
    expect(resourceSamplerOwnerCount(request as never)).toBe(0); expect(vi.getTimerCount()).toBe(0);
    await act(async () => pending.at(-1)!({ ...fixture(), sample: { ...fixture().sample, agentId: "switch-99" } }));
    expect(resourceSamplerOwnerCount(request as never)).toBe(0);
  });
  it("retains one inactive mounted inspector owner and deduplicates its reactivation with a new header", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_method, params) => ({ ...fixture(), sample: { ...fixture().sample, agentId: params.agentId } }));
    let r!: ReturnType<typeof create>; let h!: ReturnType<typeof create>;
    await act(async () => { r = create(<AgentResources agentId="a" request={request as never} />); h = create(header("a", request)); });
    await open(r); expect(request).toHaveBeenCalledTimes(1);
    act(() => r.root.findByType("details").props.onToggle({ currentTarget: { open: false } }));
    await act(async () => h.update(header("b", request))); expect(resourceSamplerOwnerCount(request as never)).toBe(2);
    await act(async () => h.update(header("a", request))); expect(resourceSamplerOwnerCount(request as never)).toBe(1);
    expect(request).toHaveBeenCalledTimes(3); await open(r); expect(request).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTime(5000)); expect(request).toHaveBeenCalledTimes(4);
    act(() => { h.unmount(); r.unmount(); });
    expect(resourceSamplerOwnerCount(request as never)).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it("separates null CPU delta and unavailable RSS from zero measurements", async () => {
    const request = vi.fn(async () => ({ ...fixture(), sample: { ...fixture().sample, totals: { procCount: 1, cpuPct: null, rssBytes: null } } }));
    let h!: ReturnType<typeof create>; await act(async () => { h = create(header("a", request)); });
    expect(text(h)).toContain("measuring"); expect(text(h)).toContain("unavailable"); expect(text(h)).not.toContain("0 MiB");
    const summary = h.root.findByProps({ "data-resource-summary": true });
    expect(summary.findAllByType("span").some(s => s.children.join("").includes("RAM unavailable"))).toBe(true);
    act(() => h.unmount());
  });
});

it("keeps a single resource owner through production StrictMode effect replay", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async () => fixture()); let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<React.StrictMode>{header("a", request)}<AgentResources agentId="a" request={request as never} /></React.StrictMode>); });
  expect(resourceSamplerOwnerCount(request as never)).toBe(1); expect(vi.getTimerCount()).toBe(1);
  const calls = request.mock.calls.length;
  await open(r); expect(request).toHaveBeenCalledTimes(calls);
  await act(async () => vi.advanceTimersByTime(5000)); expect(request).toHaveBeenCalledTimes(calls + 1);
  act(() => r.unmount()); expect(resourceSamplerOwnerCount(request as never)).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
