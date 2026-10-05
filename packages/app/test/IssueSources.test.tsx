import { afterEach, describe, expect, it, vi } from "vitest";
import { act, create } from "react-test-renderer";
import * as React from "react";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const rpc = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => []);
vi.mock("../src/rpc/bridge", () => ({ rpcCall: (m: string, p?: unknown) => rpc(m,p), subscribeEvents: async () => {}, onDaemonEvent: () => () => {}, onDaemonState: () => () => {}, daemonStatus: async () => "connected", setDockBadge: async () => {} }));
import { IssueSources, IssueChip } from "../src/components/IssueSources";
import { queueIssues } from "../src/state/commands.issues";
import { appStore } from "../src/state/store";
const source = { id: "11111111-1111-4111-8111-111111111111", projectId: "p", repo: "demo/repo", labels: [], state: "open", queue: "work", enabled: true, lastSyncAt: null, lastError: null };
const defer = () => { let resolve!: (v: unknown) => void; let reject!: (e: unknown) => void; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
let rendered: ReturnType<typeof create> | null = null;
afterEach(() => { if (rendered) act(() => rendered!.unmount()); rendered=null; vi.clearAllMocks(); });
describe("Issue Sources", () => {
  it("task/review events refresh actual board status while unrelated events do not load", async () => {
    appStore.dispatch({ type:"connected", connected:true }); let boardStatus="working";
    rpc.mockImplementation(async m=>m === "issues.sourceList" ? [] : [{taskId:"event-task",boardStatus}]);
    const owner=queueIssues("live-status"); const stop=owner.watch(); await new Promise(r=>setTimeout(r,0));
    const initial=rpc.mock.calls.length;
    const seq=(appStore.getState().events.at(-1)?.seq ?? 0)+1;
    appStore.dispatch({type:"event",event:{seq,ts:1,agentId:"other",kind:"status",data:{state:"running"}}}); expect(rpc.mock.calls).toHaveLength(initial);
    boardStatus="awaiting_review";
    appStore.dispatch({type:"event",event:{seq:seq+1,ts:2,agentId:"worker",kind:"task_state_changed",data:{queue:"live-status",taskId:"event-task",state:"done"}}}); await new Promise(r=>setTimeout(r,0));
    expect(owner.get().links[0]!.boardStatus).toBe("awaiting_review");
    boardStatus="accepted";
    appStore.dispatch({type:"event",event:{seq:seq+2,ts:3,agentId:"task:event-task",kind:"review_changed",data:{taskId:"event-task"}}}); await new Promise(r=>setTimeout(r,0));
    expect(owner.get().links[0]!.boardStatus).toBe("accepted"); stop();
  });
  it("issue-chip native button keys do not bubble to the clickable task row", async () => {
    rpc.mockImplementation(async m => m === "issues.sourceList" ? [] : [{ taskId:"task", repo:"demo/repo", number:1, url:"https://github.com/demo/repo/issues/1", boardStatus:"queued", state:"open", changed:false }]);
    await act(async()=> { rendered=create(<IssueChip queue="chip-keys" taskId="task" />); });
    const stopPropagation=vi.fn(); rendered!.root.findByProps({"data-issue-chip":true}).props.onKeyDown({key:"Enter",stopPropagation}); expect(stopPropagation).toHaveBeenCalledOnce();
  });
  it("shares one fetch between consumers, invalidates disconnect and discards an older empty response", async () => {
    appStore.dispatch({ type: "connected", connected: true }); const older=defer(); const newer=defer(); const replies=[older,newer];
    rpc.mockImplementation(async m => m === "issues.sourceList" ? replies.shift()!.promise : []);
    const owner=queueIssues("generation-test"); const stop=owner.watch(); const stop2=owner.watch(); expect(rpc.mock.calls.filter(([m])=>m === "issues.sourceList")).toHaveLength(1);
    appStore.dispatch({ type: "connected", connected: false }); appStore.dispatch({ type: "connected", connected: true });
    newer.resolve([source]); await new Promise(r=>setTimeout(r,0)); older.resolve([]); await new Promise(r=>setTimeout(r,0));
    expect(owner.get().sources).toEqual([source]); expect(owner.status.getState()).toMatchObject({ loaded:true, error:null }); stop(); stop2();
  });
  it("actual component distinguishes load failure/empty/unsupported and retains a setup draft through refresh", async () => {
    const first=defer(); rpc.mockImplementation(async m => m === "issues.sourceList" ? first.promise : []);
    await act(async()=> { rendered=create(<IssueSources queue="component-test" />); });
    const text=()=>JSON.stringify(rendered!.toJSON()); expect(text()).toContain("loading "); expect(text()).not.toContain("No sources bound");
    await act(async()=> { first.reject({ code:"transport", message:"offline" }); }); expect(text()).toContain("offline");
    rpc.mockImplementation(async()=>[]); await act(async()=> { await queueIssues("component-test").load(); }); expect(text()).toContain("No sources bound");
    const add=rendered!.root.findAllByType("button").find(b=>b.children.includes("Add source"))!;
    act(()=>add.props.onClick()); const input=rendered!.root.findAllByType("input")[0]!;
    act(()=>input.props.onChange({ target:{ value:"retained-project" } }));
    rpc.mockImplementation(async m => m === "issues.sourceList" ? [source] : []); await act(async()=> { await queueIssues("component-test").load(); });
    expect(rendered!.root.findAllByType("input")[0]!.props.value).toBe("retained-project");
    rpc.mockImplementation(async()=>{ throw { code:"protocol", message:"unknown method issues.sourceList" }; }); await act(async()=> { await queueIssues("component-test").load(); });
    expect(text()).toContain("unavailable on this daemon"); expect(rendered!.root.findAll(n=>n.props["data-load-retry"] !== undefined)).toHaveLength(0);
  });
  it("setup creates a paused-source queue by default and binds a running queue only with explicit acknowledgement", async () => {
    const calls: unknown[]=[]; rpc.mockImplementation(async (m,p) => { if(m === "issues.sourceUpsert") { calls.push(p); return source; } if(m === "queue.status") return { spec:{name:"work"}, tasks:[], counts:{} }; return []; });
    await act(async()=> { rendered=create(<IssueSources queue="setup-test" />); });
    act(()=>rendered!.root.findAllByType("button").find(b=>b.children.includes("Add source"))!.props.onClick());
    act(()=>{ const inputs=rendered!.root.findAllByType("input"); inputs[0]!.props.onChange({target:{value:"p"}}); inputs[1]!.props.onChange({target:{value:"demo/repo"}}); });
    await act(async()=> { await rendered!.root.findByType("form").props.onSubmit({preventDefault(){}}); await new Promise(r=>setTimeout(r,0)); });
    expect(calls).toEqual([{ projectId:"p", repo:"demo/repo", labels:[], state:"open" }]);
    act(()=>rendered!.root.findAllByType("button").find(b=>b.children.includes("Add source"))!.props.onClick());
    act(()=>rendered!.root.findAllByType("input")[3]!.props.onChange({target:{checked:true}}));
    act(()=>rendered!.root.findAllByType("input")[4]!.props.onChange({target:{checked:true}}));
    await act(async()=> { rendered!.root.findByType("form").props.onSubmit({preventDefault(){}}); await new Promise(r=>setTimeout(r,0)); });
    expect(calls[1]).toEqual({ projectId:"p", repo:"demo/repo", labels:[], state:"open", queue:"setup-test", allowRunningQueue:true });
  });
});
