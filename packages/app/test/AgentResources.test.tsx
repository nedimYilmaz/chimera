import * as React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
const connection = vi.hoisted(() => ({ connected: true, listeners: new Set<() => void>() }));
vi.mock("../src/state/store", () => ({ appStore: { getState: () => connection, subscribe: (fn: () => void) => { connection.listeners.add(fn); return () => connection.listeners.delete(fn); } } }));
vi.mock("../src/rpc/bridge", () => ({ rpcCall: vi.fn() }));
import { AgentResources } from "../src/components/AgentResources";
import type { AgentResourcesResponse } from "@chimera/protocol";
const fixture = (): AgentResourcesResponse => ({
  sample: { agentId: "a", sampledAt: Date.now(), state: "ok", rootPid: 10, procs: Array.from({ length: 300 }, (_, i) => ({ pid: 10 + i, ppid: i ? 10 : 1, name: "node", role: i ? "tool" : "agent", cpuPct: null, rssBytes: 1024 ** 2, elapsedSec: 60 })), totals: { cpuPct: null, rssBytes: 300 * 1024 ** 2, procCount: 300 }, truncated: false },
  admission: { cap: 6, ceiling: 8, running: 6, healthy: true, cpuPressure: true, memPressure: false, load1: 8, cores: 8, freeMemGb: 3, explain: "load 8/8 cores, 3 GB free" },
});
const text = (r: ReturnType<typeof create>) => JSON.stringify(r.toJSON());
async function open(r: ReturnType<typeof create>) { await act(async () => r.root.findByType("details").props.onToggle({ currentTarget: { open: true } })); }
function changeConnection(value: boolean) { connection.connected = value; for (const fn of connection.listeners) fn(); }
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
