import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof window === "undefined") (globalThis as unknown as { window: unknown }).window = { addEventListener() {}, removeEventListener() {} };
const ROLE = { name: "builder", model: "gpt-6.1-sol", instructions: "build" };
const TEAM = { name: "dev", createdAt: 1, roles: { builder: { role: "builder", overrides: {} } }, maxConcurrent: 2 };
const OTHER = { ...TEAM, name: "new", createdAt: 2 };
let responses: Array<() => Promise<unknown>> = [];
const rpc = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  if (method === "team.list") return (responses.shift() ?? (() => Promise.resolve([TEAM])))();
  if (method === "role.list") return [ROLE];
  if (method === "team.status") return { spec: (params as { name: string }).name === "new" ? OTHER : TEAM, running: 0, agents: [], totalRuns: 0 };
  return [];
});
vi.mock("../src/rpc/bridge", () => ({ rpcCall: (method: string, params?: unknown) => rpc(method, params), subscribeEvents: vi.fn(async () => {}), onDaemonEvent: vi.fn(() => () => {}), onDaemonState: vi.fn(() => () => {}), daemonStatus: vi.fn(async () => "connected"), setDockBadge: vi.fn(async () => {}) }));
import { TeamsScreen } from "../src/screens/TeamsScreen";
import { RolesScreen } from "../src/screens/RolesScreen";
import { appStore } from "../src/state/store";
import { rolesStatus } from "../src/state/commands.roles";
import { getCoordCommands } from "../src/state/commands.coord";
import { rpcCall } from "../src/rpc/bridge";

const coord = getCoordCommands(appStore, rpcCall);
let view: ReturnType<typeof create> | null = null;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const flatten = (node: unknown): string => {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join("");
  return flatten((node as { children?: unknown }).children);
};
const text = () => flatten(view!.toJSON());
const attr = (name: string) => view!.root.findAll(n => typeof n.type === "string" && n.props[name] !== undefined);
const note = () => attr("data-load-status")[0];
const calls = () => rpc.mock.calls.filter(c => c[0] === "team.list").length;
function deferred() {
  let resolve!: (rows: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  rpc.mockClear(); responses = [];
  coord.teamsStatus.reset();
  rolesStatus.reset();
  act(() => {
    appStore.dispatch({ type: "teams", available: true, items: [] });
    appStore.dispatch({ type: "roles", available: true, items: [] });
    appStore.dispatch({ type: "teamDetail", detail: null });
    appStore.dispatch({ type: "connected", connected: true });
    appStore.dispatch({ type: "teamCursor", delta: -1000 });
    appStore.dispatch({ type: "roleCursor", delta: -1000 });
    appStore.dispatch({ type: "setMode", mode: "normal" });
  });
});
afterEach(() => { act(() => view?.unmount()); view = null; });
for (const Screen of [TeamsScreen, RolesScreen]) describe(Screen.name + " team list", () => {
  async function mount() { act(() => { view = create(<Screen />); }); await flush(); }
  it("pending is loading, never a successful zero or empty", async () => {
    responses = [() => deferred().promise]; await mount();
    expect(note()?.props["data-load-status"]).toBe("loading");
    expect(text()).toContain("loading teams"); expect(text()).not.toContain("no teams");
    if (Screen === TeamsScreen) expect(text()).not.toContain("(0)");
  });
  it("rejection is explicit and retry stays busy until real rows arrive", async () => {
    responses = [() => Promise.reject({ code: "transport", message: "daemon busy" })]; await mount();
    expect(note()?.props["data-load-status"]).toBe("error");
    expect(text()).toContain("daemon busy"); expect(text()).not.toContain("no teams");
    const pending = deferred(); responses = [() => pending.promise];
    act(() => attr("data-load-retry")[0]!.props.onClick()); await flush();
    expect(attr("data-load-retry")[0]!.props.disabled).toBe(true);
    await act(async () => pending.resolve([TEAM])); await flush();
    expect(note()).toBeUndefined(); expect(appStore.getState().teams.items).toEqual([TEAM]);
  });
  it("successful empty is honest and unsupported has no retry", async () => {
    responses = [() => Promise.resolve([])]; await mount();
    expect(note()).toBeUndefined(); expect(text()).toContain("no teams");
    responses = [() => Promise.reject({ code: "protocol", message: "unknown method team.list" })];
    await act(async () => coord.loadTeams()); await flush();
    expect(text()).toContain("teams require a Phase 2 daemon"); expect(attr("data-load-retry")).toHaveLength(0);
  });
  it("failed refresh retains last-good rows and labels them stale", async () => {
    await mount(); responses = [() => Promise.reject(new Error("busy"))];
    await act(async () => coord.loadTeams()); await flush();
    expect(note()?.props["data-load-status"]).toBe("stale");
    expect(appStore.getState().teams.items).toEqual([TEAM]); expect(text()).toContain("dev");
  });
  it("invalidates a pending reply on the synchronous disconnect edge", async () => {
    await mount(); const pending = deferred(); responses = [() => pending.promise];
    act(() => { void coord.loadTeams(); appStore.dispatch({ type: "connected", connected: false }); });
    await act(async () => pending.resolve([OTHER])); await flush();
    expect(appStore.getState().teams.items).toEqual([TEAM]);
    expect(note()?.props["data-load-status"]).toBe("stale"); expect(calls()).toBe(2);
  });
  it("keeps selection and unsaved draft when refreshed team rows insert above it", async () => {
    await mount();
    if (Screen === RolesScreen) {
      act(() => attr("data-role-row").find(n => n.props["data-role-row"] === "dev/builder")!.props.onClick());
      await flush();
      act(() => attr("data-override-toggle").find(n => n.props["data-override-toggle"] === "model")!.props.onClick());
      act(() => attr("data-override-input").find(n => n.props["data-override-input"] === "model")!.props.onChange({ target: { value: "unsaved-model" } }));
    } else {
      act(() => appStore.dispatch({ type: "setMode", mode: "teamForm" }));
      await flush();
      act(() => view!.root.findAllByType("input").find(n => n.props.placeholder === "")!.props.onChange({ target: { value: "unsaved-team" } }));
    }
    responses = [() => Promise.resolve([TEAM, OTHER])];
    await act(async () => coord.loadTeams()); await flush();
    if (Screen === RolesScreen) {
      expect(attr("data-override-input").find(n => n.props["data-override-input"] === "model")!.props.value).toBe("unsaved-model");
      expect(appStore.getState().roleCursor).toBe(2);
    } else {
      expect(appStore.getState().teamCursor).toBe(1);
      expect(appStore.getState().teamDetail?.spec["name"]).toBe("dev");
      expect(view!.root.findAllByType("input").find(n => n.props.placeholder === "")!.props.value).toBe("unsaved-team");
    }
  });
  it("reloads once for a batched reconnect and repeated connected events do nothing", async () => {
    await mount(); responses = [() => Promise.resolve([TEAM, OTHER])];
    act(() => { appStore.dispatch({ type: "connected", connected: false }); appStore.dispatch({ type: "connected", connected: true }); appStore.dispatch({ type: "connected", connected: true }); });
    await flush(); expect(calls()).toBe(2); expect(appStore.getState().teams.items).toEqual([TEAM, OTHER]);
  });
});

it("overlapping consumers share one initial load and connection subscription", async () => {
  act(() => { view = create(<><TeamsScreen /><RolesScreen /></>); }); await flush();
  expect(calls()).toBe(1);
  act(() => { appStore.dispatch({ type: "connected", connected: false }); appStore.dispatch({ type: "connected", connected: true }); });
  await flush(); expect(calls()).toBe(2);
  act(() => view!.unmount()); view = null;
  act(() => { appStore.dispatch({ type: "connected", connected: false }); appStore.dispatch({ type: "connected", connected: true }); });
  await flush(); expect(calls()).toBe(2);
});
it("unmounting the last consumer invalidates pending data before another surface opens", async () => {
  const pending = deferred(); responses = [() => pending.promise];
  act(() => { view = create(<TeamsScreen />); }); await flush();
  act(() => view!.unmount()); view = null;
  await act(async () => pending.resolve([OTHER])); await flush();
  expect(appStore.getState().teams.items).toEqual([]);
  responses = [() => Promise.resolve([TEAM])];
  act(() => { view = create(<RolesScreen />); }); await flush();
  expect(appStore.getState().teams.items).toEqual([TEAM]); expect(note()).toBeUndefined();
});
it("an older failed request cannot mark a newer success stale", async () => {
  const pending = deferred(); responses = [() => pending.promise];
  act(() => { view = create(<TeamsScreen />); }); await flush();
  await act(async () => coord.loadTeams());
  await act(async () => pending.reject(new Error("late failure"))); await flush();
  expect(appStore.getState().teams.items).toEqual([TEAM]); expect(note()).toBeUndefined();
});
