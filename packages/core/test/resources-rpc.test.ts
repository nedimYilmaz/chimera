import { describe, expect, it, vi } from "vitest";
import { ResourcesRpc } from "../src/rpc/resources-rpc.js";
import { ProcessTreeSampler } from "../src/process-tree.js";
import type { AgentSupervisor } from "../src/supervisor.js";
import { DynamicCapTracker } from "../src/dynamic-cap.js";
const records = [{ agentId: "a", parentId: null, state: "running", spec: {}, createdAt: 1, attempts: [] }, { agentId: "child", parentId: "a", state: "running", spec: {}, createdAt: 1, attempts: [] }, { agentId: "b", parentId: null, state: "running", spec: {}, createdAt: 1, attempts: [] }];
function fixture() {
  let now = 1000;
  const rows = records.map(r => ({ ...r }));
  const exec = vi.fn(async () => "10 1 12 01:00 00:01 Mon Oct 5 12:00:00 2026 /usr/bin/node");
  const supervisor = { status: (id: string) => { const r = rows.find(r => r.agentId === id); if (!r) throw new Error("unknown"); return r; }, list: () => rows, resourceProcessPid: (id: string) => rows.find(r => r.agentId === id)?.state === "running" ? 10 : null } as unknown as AgentSupervisor;
  const tracker = new DynamicCapTracker();
  const admission = () => ({ ...tracker.effectiveCap(8, undefined), running: 3 });
  const rpc = new ResourcesRpc({ supervisor, admission, sampler: new ProcessTreeSampler(exec, () => now, "darwin"), now: () => now });
  return { rpc, exec, rows, admission, tick: () => { now += 2100; } };
}
describe("read-only resource RPCs", () => {
  it("resolves an exact tmux pane, and never probes tmux on unsupported Windows", async () => {
    const record = { ...records[0], spec: { runtime: "terminal" } };
    const supervisor = { status: () => record, list: () => [record], resourceProcessPid: () => null } as unknown as AgentSupervisor;
    const exec = vi.fn(async (file: string) => file === "tmux" ? "10\n" : "10 1 12 01:00 00:01 Mon Oct 5 12:00:00 2026 sh");
    const admission = () => ({ ...new DynamicCapTracker().effectiveCap(8, undefined), running: 1 });
    const rpc = new ResourcesRpc({ supervisor, admission, exec, platform: "darwin" });
    expect(await rpc.handlers["agent.resources"]({ agentId: "a" })).toMatchObject({ sample: { rootPid: 10, procs: [{ role: "terminal" }] } });
    expect(exec.mock.calls[0]).toEqual(["tmux", ["list-panes", "-t", "=chimera-a", "-F", "#{pane_pid}"]]);
    exec.mockClear();
    const windows = new ResourcesRpc({ supervisor, admission, exec, platform: "win32" });
    expect(await windows.handlers["agent.resources"]({ agentId: "a" })).toMatchObject({ sample: { reason: "platform" } });
    expect(exec).not.toHaveBeenCalled();
  });
  it("coalesces on demand and projects the existing admission snapshot without changing it", async () => {
    const f = fixture();
    const [a,b] = await Promise.all([f.rpc.handlers["agent.resources"]({ agentId: "a" }), f.rpc.handlers["agent.resources"]({ agentId: "a" })]);
    expect(a).toEqual(b); expect(f.exec).toHaveBeenCalledTimes(1);
    expect(a.admission).toEqual(f.admission());
    expect(await f.rpc.handlers["host.admission"]({})).toEqual(f.admission());
    f.tick(); await f.rpc.handlers["agent.resources"]({ agentId: "a" }); expect(f.exec).toHaveBeenCalledTimes(2);
  });
  it("allows self/descendants and rejects unrelated callers, with no sampling on denial", async () => {
    const f = fixture();
    await expect(f.rpc.handlers["agent.resources"]({ agentId: "b", callerAgentId: "a" })).rejects.toThrow("denied");
    expect(f.exec).not.toHaveBeenCalled();
    await expect(f.rpc.handlers["agent.resources"]({ agentId: "child", callerAgentId: "a" })).resolves.toMatchObject({ sample: { agentId: "child" } });
  });
  it("keeps last-good measurements on sampling failure; never reuses them for ended workers", async () => {
    const f = fixture();
    const good = await f.rpc.handlers["agent.resources"]({ agentId: "a" }); f.tick();
    f.exec.mockRejectedValueOnce(new Error("ps failed"));
    expect(await f.rpc.handlers["agent.resources"]({ agentId: "a" })).toMatchObject({ sample: { state: "stale", sampledAt: good.sample.sampledAt, procs: good.sample.procs } });
    f.rows[0]!.state = "done";
    expect(await f.rpc.handlers["agent.resources"]({ agentId: "a" })).toMatchObject({ sample: { state: "unavailable", reason: "no_process", procs: [] } });
  });
  it("does not reuse old measurements after a same-PID worker relaunch", async () => {
    const f = fixture();
    await f.rpc.handlers["agent.resources"]({ agentId: "a" });
    f.rows[0]!.createdAt = 2;
    f.exec.mockRejectedValueOnce(new Error("ps failed"));
    expect(await f.rpc.handlers["agent.resources"]({ agentId: "a" })).toMatchObject({ sample: { state: "unavailable", reason: "sampling", procs: [] } });
  });
  it("drops an in-flight measurement when the worker ends", async () => {
    const f = fixture();
    let resolve!: (s: string) => void;
    f.exec.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = f.rpc.handlers["agent.resources"]({ agentId: "a" });
    f.rows[0]!.state = "done"; resolve("10 1 12 01:00 00:01 Mon Oct 5 12:00:00 2026 node");
    expect(await pending).toMatchObject({ sample: { state: "unavailable" } });
  });
});
