import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

// UX26-UI: the Roles pane used to show "roles (0)", "no roles — ⌘O creates one" and "no teams yet"
// whenever role.list was merely slow or had failed once — the store default is indistinguishable
// from a real empty library.  These drive the ACTUAL screen through pending / failed / stale /
// unsupported / reconnect / out-of-order loads, and through a refresh that reshuffles the rows
// under an unsaved binding override.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const CUSTOM = { name: "custom", model: "claude-sonnet-5", permissionProfile: "acceptEdits", instructions: "do the thing", plugins: [], mcpToolAllowlist: {}, skills: [] };
const BUILDER_LIB = { name: "dev.builder", cwd: "/tmp/dev", model: "claude-sonnet-5", permissionProfile: "acceptEdits", instructions: "build stuff" };
const REVIEWER_LIB = { name: "dev.reviewer", cwd: "/tmp/dev", model: "claude-opus-5", permissionProfile: "readOnly", instructions: "review stuff" };
const ALPHA = { name: "alpha", model: "claude-sonnet-5", permissionProfile: "acceptEdits", instructions: "inserted elsewhere" };
const BASE_ROLES = [CUSTOM, BUILDER_LIB, REVIEWER_LIB];

const TEAM_SPEC = {
  name: "dev",
  roles: {
    builder: { role: "dev.builder", overrides: {} },
    reviewer: { role: "dev.reviewer", overrides: { model: "claude-haiku-4-5" } },
  },
  discoveredRoles: [], maxConcurrent: 2,
};

type Responder = () => Promise<unknown>;
// Each role.list call consumes the next queued responder; an empty queue answers BASE_ROLES.
let roleListQueue: Responder[] = [];
let teamListImpl: Responder = () => Promise.resolve([TEAM_SPEC]);

const rpcImpl = vi.fn(async (method: string): Promise<unknown> => {
  if (method === "role.list") return (roleListQueue.shift() ?? (() => Promise.resolve(BASE_ROLES)))();
  if (method === "team.list") return teamListImpl();
  if (method === "team.status") return { spec: TEAM_SPEC, running: 0, agents: [], totalRuns: 0 };
  return [];
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { RolesScreen } from "../src/screens/RolesScreen";
import { appStore } from "../src/state/store";
import { rolesStatus } from "../src/state/commands.roles";
import styles from "../src/screens/RolesScreen.module.css";
import { handleHotkey } from "../src/keymap";

function defer<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const setConnected = (connected: boolean) => act(() => { appStore.dispatch({ type: "connected", connected }); });

let mounted: ReturnType<typeof create> | null = null;
const root = () => mounted!.root;

const flat = (n: unknown): string => {
  if (n === null || n === undefined) return "";
  if (typeof n === "string") return n;
  if (Array.isArray(n)) return n.map(flat).join("");
  return flat((n as { children?: unknown }).children);
};
const screenText = () => flat(mounted!.toJSON());

const byAttr = (attr: string) => root().findAll((n) => typeof n.type === "string" && n.props[attr] !== undefined);
const loadNote = () => byAttr("data-load-status")[0];
const roleListCalls = () => rpcImpl.mock.calls.filter((c) => c[0] === "role.list").length;
const selectedRowIds = () =>
  root().findAll((n) => typeof n.type === "string" && n.props["data-role-row"] !== undefined && n.props.className === styles.rowSelected)
    .map((n) => n.props["data-role-row"] as string);

async function mountScreen() {
  act(() => { mounted = create(React.createElement(RolesScreen)); });
  await flush();
}

beforeEach(() => {
  rpcImpl.mockClear();
  roleListQueue = [];
  teamListImpl = () => Promise.resolve([TEAM_SPEC]);
  rolesStatus.reset();
  act(() => {
    appStore.dispatch({ type: "roles", available: true, items: [] });
    appStore.dispatch({ type: "teams", available: true, items: [] });
    appStore.dispatch({ type: "connected", connected: true });
    appStore.dispatch({ type: "roleCursor", delta: -1000 });
  });
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("RolesScreen load state", () => {
  it("while role.list/team.list are pending it says loading — never 'roles (0)', 'no roles' or 'no teams yet'", async () => {
    roleListQueue = [() => defer<unknown>().promise];
    teamListImpl = () => defer<unknown>().promise;
    await mountScreen();

    expect(loadNote()!.props["data-load-status"]).toBe("loading");
    const text = screenText();
    expect(text).toContain("roles (…)");
    expect(text).toContain("loading teams…");
    expect(text).not.toContain("roles (0)");
    expect(text).not.toContain("no roles");
    expect(text).not.toContain("no teams yet");
  });

  it("a genuinely empty library is stated as empty only AFTER role.list answered", async () => {
    roleListQueue = [() => Promise.resolve([])];
    teamListImpl = () => Promise.resolve([]);
    await mountScreen();

    expect(loadNote()).toBeUndefined();
    const text = screenText();
    expect(text).toContain("roles (0)");
    expect(text).toContain("no roles");
    expect(text).toContain("no teams yet");
  });

  it("a rejected role.list shows the error with a retry (not an empty library), and retry recovers", async () => {
    roleListQueue = [() => Promise.reject({ code: "transport", message: "daemon busy" })];
    await mountScreen();

    const note = loadNote()!;
    expect(note.props["data-load-status"]).toBe("error");
    expect(screenText()).toContain("couldn't load roles");
    expect(screenText()).toContain("daemon busy");
    expect(screenText()).not.toContain("no roles");
    expect(root().findAllByProps({ "data-role-row": "custom" }).length).toBe(0);

    const retry = byAttr("data-load-retry")[0]!;
    act(() => { (retry.props as { onClick: () => void }).onClick(); });
    await flush();

    expect(roleListCalls()).toBe(2);
    expect(loadNote()).toBeUndefined();
    expect(root().findAllByProps({ "data-role-row": "custom" }).length).toBe(1);
  });

  it("a failed REFRESH keeps the last good rows and flags them stale instead of blanking the library", async () => {
    await mountScreen();
    expect(root().findAllByProps({ "data-role-row": "custom" }).length).toBe(1);

    roleListQueue = [() => Promise.reject({ code: "transport", message: "socket closed" })];
    await setConnected(false);
    await setConnected(true);
    await flush();

    expect(loadNote()!.props["data-load-status"]).toBe("stale");
    expect(screenText()).toContain("showing last loaded roles");
    expect(root().findAllByProps({ "data-role-row": "custom" }).length).toBe(1);
    expect(screenText()).not.toContain("no roles");
  });

  it("unknown-method is an explicit unsupported state: one call, no retry affordance, no error note", async () => {
    roleListQueue = [() => Promise.reject({ code: "protocol", message: "unknown method role.list" })];
    await mountScreen();

    expect(roleListCalls()).toBe(1);
    expect(screenText()).toContain("requires a Phase 2 daemon");
    expect(loadNote()).toBeUndefined();
    expect(byAttr("data-load-retry").length).toBe(0);
    expect(screenText()).not.toContain("no roles");
    expect(appStore.getState().roles.available).toBe(false);
  });

  it("reloads exactly once per reconnect edge: mounting while connected does not double-fetch, true→true is a no-op", async () => {
    await mountScreen();
    expect(roleListCalls()).toBe(1);

    await setConnected(true);
    await flush();
    expect(roleListCalls()).toBe(1);

    await setConnected(false);
    await flush();
    expect(roleListCalls()).toBe(1);

    await setConnected(true);
    await flush();
    expect(roleListCalls()).toBe(2);
  });

  it("an out-of-order reconnect reload cannot overwrite newer data or flip the status", async () => {
    const older = defer<unknown>();
    const newer = defer<unknown>();
    roleListQueue = [() => older.promise, () => newer.promise];
    await mountScreen();
    expect(roleListCalls()).toBe(1);

    await setConnected(false);
    await setConnected(true);
    await flush();
    expect(roleListCalls()).toBe(2);

    await act(async () => { newer.resolve([ALPHA]); });
    await flush();
    expect(root().findAllByProps({ "data-role-row": "alpha" }).length).toBe(1);

    await act(async () => { older.resolve(BASE_ROLES); });
    await flush();
    expect(root().findAllByProps({ "data-role-row": "alpha" }).length).toBe(1);
    expect(root().findAllByProps({ "data-role-row": "custom" }).length).toBe(0);

    // …and an older FAILURE arriving late must not mark the fresh rows stale either.
    const lateFail = defer<unknown>();
    const fresh = defer<unknown>();
    roleListQueue = [() => lateFail.promise, () => fresh.promise];
    await setConnected(false);
    await setConnected(true);
    await flush();
    await setConnected(false);
    await setConnected(true);
    await flush();
    await act(async () => { fresh.resolve([ALPHA, CUSTOM]); });
    await flush();
    await act(async () => { lateFail.reject({ code: "transport", message: "late" }); });
    await flush();
    expect(loadNote()).toBeUndefined();
    expect(root().findAllByProps({ "data-role-row": "custom" }).length).toBe(1);
  });

  it("keeps the SAME role selected — and its unsaved override edit — when a refresh inserts rows above it", async () => {
    await mountScreen();
    const builder = root().findAllByProps({ "data-role-row": "dev/builder" })[0]!;
    act(() => { (builder.props as { onClick: () => void }).onClick(); });
    await flush();
    expect(selectedRowIds()).toEqual(["dev/builder"]);

    act(() => { (byAttr("data-override-toggle").find((n) => n.props["data-override-toggle"] === "model")!.props as { onClick: () => void }).onClick(); });
    const input = () => byAttr("data-override-input").find((n) => n.props["data-override-input"] === "model")!;
    act(() => { (input().props as { onChange: (e: unknown) => void }).onChange({ target: { value: "claude-opus-5" } }); });
    expect(input().props.value).toBe("claude-opus-5");
    expect(byAttr("data-override-save").length).toBe(1);

    // a role created elsewhere lands ABOVE the selection → every index below it shifts by one
    roleListQueue = [() => Promise.resolve([ALPHA, ...BASE_ROLES])];
    await setConnected(false);
    await setConnected(true);
    await flush();

    expect(root().findAllByProps({ "data-role-row": "alpha" }).length).toBe(1);
    expect(selectedRowIds()).toEqual(["dev/builder"]);
    expect(input().props.value).toBe("claude-opus-5");
    expect(byAttr("data-override-save").length).toBe(1);
    // library rows 3→4, so dev/builder (the first team row) moved from index 3 to 4 — the store follows the ROW, not the old index
    expect(appStore.getState().roleCursor).toBe(4);
  });

  it("a click the user makes wins over the remembered row; the new row is then the one that sticks", async () => {
    await mountScreen();
    const builder = root().findAllByProps({ "data-role-row": "dev/builder" })[0]!;
    act(() => { (builder.props as { onClick: () => void }).onClick(); });
    await flush();
    const reviewer = root().findAllByProps({ "data-role-row": "dev/reviewer" })[0]!;
    act(() => { (reviewer.props as { onClick: () => void }).onClick(); });
    await flush();
    expect(selectedRowIds()).toEqual(["dev/reviewer"]);

    roleListQueue = [() => Promise.resolve([ALPHA, ...BASE_ROLES])];
    await setConnected(false);
    await setConnected(true);
    await flush();

    expect(selectedRowIds()).toEqual(["dev/reviewer"]);
  });

  it("when the selected row disappears the cursor clamps to the last row instead of pointing past the list", async () => {
    await mountScreen();
    const reviewer = root().findAllByProps({ "data-role-row": "dev/reviewer" })[0]!;
    act(() => { (reviewer.props as { onClick: () => void }).onClick(); });
    await flush();
    expect(appStore.getState().roleCursor).toBe(4);

    roleListQueue = [() => Promise.resolve([CUSTOM])];
    await setConnected(false);
    await setConnected(true);
    await flush();

    // rows now: custom + dev/builder + dev/reviewer (team rows) = 3 → clamp stays in range
    expect(appStore.getState().roleCursor).toBeLessThanOrEqual(2);
    expect(selectedRowIds().length).toBe(1);
  });
});

// The Tauri driver settles pending calls on a socket drop, but a reply it resolved just BEFORE the
// drop can still arrive after the `connected:false` event.  Nothing newer has started yet, so
// without RolesScreen interrupting the load that reply would repaint pre-drop rows as fresh.
describe("RolesScreen — connection drop while a refresh is in flight", () => {
  // load #1 settles (BASE_ROLES); a reconnect edge starts load #2 and leaves it pending
  async function mountWithRefreshInFlight() {
    await mountScreen();
    const inFlight = defer<unknown>();
    roleListQueue = [() => inFlight.promise];
    await setConnected(false);
    await setConnected(true);
    await flush();
    expect(roleListCalls()).toBe(2);
    return inFlight;
  }

  it("a late reply after the drop is dropped: last-good rows stay, flagged stale, no polling", async () => {
    const inFlight = await mountWithRefreshInFlight();

    await setConnected(false);
    await flush();
    await act(async () => { inFlight.resolve([ALPHA]); });
    await flush();

    expect(loadNote()!.props["data-load-status"]).toBe("stale");
    expect(screenText()).toContain("connection to the daemon was lost");
    expect(root().findAllByProps({ "data-role-row": "custom" }).length).toBe(1);
    expect(root().findAllByProps({ "data-role-row": "alpha" }).length).toBe(0);
    expect(roleListCalls()).toBe(2); // the drop itself never re-requests
  });

  it("the driver's own {code:'disconnected'} rejection after the drop keeps the stale note instead of replacing it", async () => {
    const inFlight = await mountWithRefreshInFlight();

    await setConnected(false);
    await act(async () => { inFlight.reject({ code: "disconnected", message: "chimerad connection closed" }); });
    await flush();

    expect(loadNote()!.props["data-load-status"]).toBe("stale");
    expect(screenText()).toContain("connection to the daemon was lost");
    expect(root().findAllByProps({ "data-role-row": "custom" }).length).toBe(1);
  });

  it("the reconnect reload then replaces the stale rows and clears the note", async () => {
    const inFlight = await mountWithRefreshInFlight();
    await setConnected(false);
    await act(async () => { inFlight.resolve([ALPHA]); });
    await flush();

    roleListQueue = [() => Promise.resolve([ALPHA, ...BASE_ROLES])];
    await setConnected(true);
    await flush();

    expect(roleListCalls()).toBe(3);
    expect(loadNote()).toBeUndefined();
    expect(root().findAllByProps({ "data-role-row": "alpha" }).length).toBe(1);
    expect(root().findAllByProps({ "data-role-row": "custom" }).length).toBe(1);
  });

  it("dropping while NOTHING is in flight leaves a healthy library untouched (no spurious stale note)", async () => {
    await mountScreen();

    await setConnected(false);
    await flush();

    expect(loadNote()).toBeUndefined();
    expect(root().findAllByProps({ "data-role-row": "custom" }).length).toBe(1);
  });
});



it("keyboard selection uses rows fetched after mount, including refreshed rows", async () => {
  act(() => appStore.dispatch({ type: "selectTab", tab: "roles" }));
  await mountScreen();
  const down = () => act(() => handleHotkey({ key: "ArrowDown", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, repeat: false, preventDefault() {} }, appStore));
  down();
  await flush();
  expect(appStore.getState().roleCursor).toBe(1);
  roleListQueue = [() => Promise.resolve([ALPHA, ...BASE_ROLES])];
  await setConnected(false);
  await setConnected(true);
  await flush();
  expect(appStore.getState().roleCursor).toBe(2);
  down();
  await flush();
  expect(appStore.getState().roleCursor).toBe(3);
});


it("does not lose connection edges batched before React renders", async () => {
  await mountScreen();
  roleListQueue = [() => Promise.resolve([ALPHA, ...BASE_ROLES])];
  act(() => {
    appStore.dispatch({ type: "connected", connected: false });
    appStore.dispatch({ type: "connected", connected: true });
  });
  await flush();
  expect(roleListCalls()).toBe(2);
  expect(root().findAllByProps({ "data-role-row": "alpha" }).length).toBe(1);
});
