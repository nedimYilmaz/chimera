import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ConcurrencyCapSection } from "../src/screens/SettingsScreen";
import { getSettingsCommands } from "../src/state/commands.settings";
import { appStore } from "../src/state/store";
import { rpcCall } from "../src/rpc/bridge";
import { LOWERING_CAP_NEVER_STOPS_RUNNING_AGENTS } from "../src/state/selectors.settings";

// CONCURRENCY-CAP-UI: a typed control for caps.maxAgentsTotal/dynamicCap/perAccount,
// replacing the raw-JSON config_patch escape hatch for this one knob (operator's
// verbatim complaint: "can I change this limit dynamically from the UI? when I lower
// it, what happens to open agents?"). Exercises the ACTUAL rendered output + the
// ACTUAL emitted config.patch payload — never just local component state.

let daemonStatus: Record<string, unknown> = { engineId: "studio", dailyCapUsd: null, agents: { running: 4 }, agentCap: null };
let configGet: Record<string, unknown> = { autoOrder: [], dailyCapUsd: null, caps: { maxAgentsTotal: 12, perAccount: {} } };
let accountsList: Array<Record<string, unknown>> = [{ name: "main", provider: "claude", authType: "keychain" }];

vi.mock("../src/rpc/bridge", () => {
  return {
    rpcCall: vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method === "daemon.status") return Promise.resolve(daemonStatus);
      if (method === "config.get") return Promise.resolve(configGet);
      if (method === "accounts.list") return Promise.resolve(accountsList);
      if (method === "providers.list") return Promise.resolve([]);
      if (method === "config.patch") return Promise.resolve({ ok: true, changed: ["caps"] });
      return Promise.resolve(undefined);
    }),
    openArtifactUrl: vi.fn(() => Promise.resolve()),
    onDaemonEvent: vi.fn(() => () => {}),
    onDaemonState: vi.fn(() => () => {}),
    subscribeEvents: vi.fn().mockResolvedValue(undefined),
  };
});

function find(root: ReactTestInstance, key: string, value?: string): ReactTestInstance {
  return root.find((node) => node.props[key] !== undefined && (value === undefined || node.props[key] === value));
}
function findAll(root: ReactTestInstance, key: string): ReactTestInstance[] {
  return root.findAll((node) => node.props[key] !== undefined);
}

const cmds = getSettingsCommands(appStore, rpcCall);

beforeEach(() => {
  daemonStatus = { engineId: "studio", dailyCapUsd: null, agents: { running: 4 }, agentCap: null };
  configGet = { autoOrder: [], dailyCapUsd: null, caps: { maxAgentsTotal: 12, perAccount: {} } };
  accountsList = [{ name: "main", provider: "claude", authType: "keychain" }];
});

async function mount(): Promise<ReactTestRenderer> {
  await act(async () => { await Promise.all([cmds.loadGeneral(), cmds.loadProviders()]); });
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<ConcurrencyCapSection />); });
  return view;
}

describe("live display — three render states (ACCEPTANCE #2)", () => {
  it("dynamic cap off: shows only the static ceiling, no ceiling/explain clutter", async () => {
    const view = await mount();
    expect(find(view.root, "data-cap-effective").children.join("")).toBe("12");
    expect(find(view.root, "data-cap-dynamic-state").children.join("")).toMatch(/dynamic cap off/);
    expect(findAll(view.root, "data-cap-explain")).toHaveLength(0);
  });

  it("dynamic cap on, not narrowing: effective cap === ceiling, no 'of' split, explain is shown", async () => {
    configGet = { autoOrder: [], dailyCapUsd: null, caps: { maxAgentsTotal: 12, perAccount: {}, dynamicCap: {
      enabled: true, floor: 2, cpuHighWatermark: 0.9, cpuLowWatermark: 0.7, cpuCriticalRatio: 1.5,
      memLowWatermarkGb: 2, memHighWatermarkGb: 4, memCriticalGb: 0.5, emaAlpha: 0.3,
    } } };
    daemonStatus = { engineId: "studio", dailyCapUsd: null, agents: { running: 4 }, agentCap: {
      cap: 12, ceiling: 12, healthy: true, cpuPressure: false, memPressure: false, load1: 3, cores: 12, freeMemGb: 10,
      explain: "load 3.0/12 cores, 10.0 GB free",
    } };
    const view = await mount();
    expect(find(view.root, "data-cap-effective").children.join("")).toBe("12");
    expect(find(view.root, "data-cap-dynamic-state").children.join("")).toMatch(/no pressure/);
    expect(find(view.root, "data-cap-explain").children.join("")).toBe("load 3.0/12 cores, 10.0 GB free");
  });

  it("dynamic cap on, actively narrowing: shows effective vs. ceiling AND the explain inputs", async () => {
    configGet = { autoOrder: [], dailyCapUsd: null, caps: { maxAgentsTotal: 12, perAccount: {}, dynamicCap: {
      enabled: true, floor: 2, cpuHighWatermark: 0.9, cpuLowWatermark: 0.7, cpuCriticalRatio: 1.5,
      memLowWatermarkGb: 2, memHighWatermarkGb: 4, memCriticalGb: 0.5, emaAlpha: 0.3,
    } } };
    daemonStatus = { engineId: "studio", dailyCapUsd: null, agents: { running: 11 }, agentCap: {
      cap: 5, ceiling: 12, healthy: true, cpuPressure: true, memPressure: false, load1: 11.4, cores: 12, freeMemGb: 3.2,
      explain: "load 11.4/12 cores, 3.2 GB free",
    } };
    const view = await mount();
    expect(find(view.root, "data-cap-effective").children.join("")).toBe("5 of 12");
    expect(find(view.root, "data-cap-dynamic-state").children.join("")).toMatch(/narrowing/);
    expect(find(view.root, "data-cap-explain").children.join("")).toBe("load 11.4/12 cores, 3.2 GB free");
    expect(find(view.root, "data-cap-running").children.join("")).toBe("11");
  });
});

describe("the 'lowering never stops running agents' statement is always rendered (ACCEPTANCE #4)", () => {
  it("is present regardless of dynamic-cap state", async () => {
    const view = await mount();
    expect(find(view.root, "data-cap-lower-warning").children.join("")).toBe(LOWERING_CAP_NEVER_STOPS_RUNNING_AGENTS);
  });
});

describe("ceiling edit → config.patch {caps: {maxAgentsTotal}} (ACCEPTANCE #1)", () => {
  it("emits the exact RPC payload and the new value reflects back from the daemon", async () => {
    const view = await mount();
    await act(async () => { find(view.root, "data-maxagents-edit").props.onClick(); });
    await act(async () => { find(view.root, "data-maxagents-input").props.onChange({ target: { value: "20" } }); });
    configGet = { autoOrder: [], dailyCapUsd: null, caps: { maxAgentsTotal: 20, perAccount: {} } };
    await act(async () => { await find(view.root, "data-maxagents-save").props.onClick(); });

    expect(rpcCall).toHaveBeenCalledWith("config.patch", { patch: { caps: { maxAgentsTotal: 20 } } });
    expect(find(view.root, "data-maxagents-value").children.join("")).toBe("20");
  });
});

describe("malformed ceiling input is rejected client-side (ACCEPTANCE #3)", () => {
  it("a non-positive value shows an inline error and never calls config.patch", async () => {
    const view = await mount();
    const patchCallsBefore = (rpcCall as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "config.patch").length;
    await act(async () => { find(view.root, "data-maxagents-edit").props.onClick(); });
    await act(async () => { find(view.root, "data-maxagents-input").props.onChange({ target: { value: "0" } }); });
    await act(async () => { find(view.root, "data-maxagents-save").props.onClick(); });

    expect(find(view.root, "data-maxagents-error").children.join("")).toMatch(/greater than 0/);
    const patchCallsAfter = (rpcCall as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "config.patch").length;
    expect(patchCallsAfter).toBe(patchCallsBefore);
  });

  it("a non-numeric value shows an inline error and never calls config.patch", async () => {
    const view = await mount();
    const patchCallsBefore = (rpcCall as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "config.patch").length;
    await act(async () => { find(view.root, "data-maxagents-edit").props.onClick(); });
    await act(async () => { find(view.root, "data-maxagents-input").props.onChange({ target: { value: "not-a-number" } }); });
    await act(async () => { find(view.root, "data-maxagents-save").props.onClick(); });

    expect(find(view.root, "data-maxagents-error").children.join("")).toMatch(/whole number/);
    const patchCallsAfter = (rpcCall as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "config.patch").length;
    expect(patchCallsAfter).toBe(patchCallsBefore);
  });
});

describe("dynamic cap enable + knob edit → config.patch {caps: {dynamicCap}} (SCOPE #1)", () => {
  it("enabling the toggle and saving sends the full DynamicCapConfig", async () => {
    const view = await mount();
    await act(async () => { find(view.root, "data-dynamiccap-edit").props.onClick(); });
    await act(async () => { find(view.root, "data-dynamiccap-enabled").props.onChange({ target: { checked: true } }); });
    await act(async () => { find(view.root, "data-dynamiccap-field", "floor").props.onChange({ target: { value: "3" } }); });
    configGet = { autoOrder: [], dailyCapUsd: null, caps: { maxAgentsTotal: 12, perAccount: {}, dynamicCap: {
      enabled: true, floor: 3, cpuHighWatermark: 0.9, cpuLowWatermark: 0.7, cpuCriticalRatio: 1.5,
      memLowWatermarkGb: 2, memHighWatermarkGb: 4, memCriticalGb: 0.5, emaAlpha: 0.3,
    } } };
    await act(async () => { await find(view.root, "data-dynamiccap-save").props.onClick(); });

    const patchCall = (rpcCall as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === "config.patch" && (c[1] as { patch?: { caps?: { dynamicCap?: unknown } } })?.patch?.caps?.dynamicCap !== undefined);
    expect(patchCall?.[1]).toEqual({ patch: { caps: { dynamicCap: {
      enabled: true, floor: 3, cpuHighWatermark: 0.9, cpuLowWatermark: 0.7, cpuCriticalRatio: 1.5,
      memLowWatermarkGb: 2, memHighWatermarkGb: 4, memCriticalGb: 0.5, emaAlpha: 0.3,
    } } } });
  });

  it("an out-of-range knob (emaAlpha > 1) is rejected client-side, no patch emitted", async () => {
    const view = await mount();
    const patchCallsBefore = (rpcCall as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "config.patch").length;
    await act(async () => { find(view.root, "data-dynamiccap-edit").props.onClick(); });
    await act(async () => { find(view.root, "data-dynamiccap-field", "emaAlpha").props.onChange({ target: { value: "5" } }); });
    await act(async () => { find(view.root, "data-dynamiccap-save").props.onClick(); });

    expect(find(view.root, "data-dynamiccap-error")).toBeTruthy();
    const patchCallsAfter = (rpcCall as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "config.patch").length;
    expect(patchCallsAfter).toBe(patchCallsBefore);
  });
});

describe("per-account cap edit → config.patch {caps: {perAccount: {[name]: value}}} (SCOPE #3)", () => {
  it("sets one account's cap without an existing sibling entry going along for the ride", async () => {
    configGet = { autoOrder: [], dailyCapUsd: null, caps: { maxAgentsTotal: 12, perAccount: { other: 7 } } };
    accountsList = [
      { name: "main", provider: "claude", authType: "keychain" },
      { name: "other", provider: "claude", authType: "keychain" },
    ];
    const view = await mount();

    await act(async () => { find(view.root, "data-peraccount-edit", "main").props.onClick(); });
    await act(async () => { find(view.root, "data-peraccount-input", "main").props.onChange({ target: { value: "3" } }); });
    await act(async () => { await find(view.root, "data-peraccount-save", "main").props.onClick(); });

    expect(rpcCall).toHaveBeenCalledWith("config.patch", { patch: { caps: { perAccount: { main: 3 } } } });
  });
});
