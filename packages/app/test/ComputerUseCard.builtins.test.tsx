import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { BuiltInStatus, BuiltInsStatusResult } from "@chimera/protocol";

// Importing ComputerUseCard pulls in the app store, which wires daemon events at module load.
vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => ({})),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}),
  exportCsv: vi.fn(async () => ""),
  checkpointFilesSince: vi.fn(async () => 0),
}));

import { ComputerUseCard } from "../src/components/ComputerUseCard";

// The card shows what the INSTALLER shipped (daemon: computerUse.builtins.status) next to what the
// Chimera APP hosts (Rust: computer_use_status). These tests pin the honesty rules: Laya's
// first-use download is never described as bundled, an unsupported/missing driver says why, and the
// stale "install the integration yourself" copy is gone.

const status = { configured: true, running: false, autoStart: false, permissionOwner: "Chimera", accessibility: true, screenRecording: true };
const rows = (over: Partial<Record<BuiltInStatus["id"], Partial<BuiltInStatus>>> = {}): BuiltInsStatusResult => ({
  managed: true,
  integrations: [
    { id: "laya", state: "not-installed", provisioning: "managed-download", version: "0.3.27", modelAssets: "downloaded-on-first-use", reason: "Laya's Python packages and models download on first use.", ...over.laya },
    { id: "chimera-browser", state: "ready", provisioning: "bundled", version: "0.0.83", ...over["chimera-browser"] },
    { id: "chimera-desktop", state: "ready", provisioning: "bundled", version: "0.33.3", ...over["chimera-desktop"] },
  ] as BuiltInStatus[],
});

let renderer: ReactTestRenderer | null = null;
const root = () => renderer!.root;
const textOf = (n: ReactTestInstance): string => n.children.map(c => typeof c === "string" ? c : textOf(c)).join("");
const text = () => textOf(root());
const row = (id: string) => root().findAll(n => n.props["data-built-in"] === id)[0]!;
const button = (label: string) => root().findAll(n => n.type === "button" && textOf(n) === label)[0];

async function mount(o: { request?: (command: string, args?: Record<string, unknown>) => Promise<unknown>; native?: object; built?: () => Promise<unknown>; install?: (id: "laya") => Promise<unknown> }) {
  const request = vi.fn(o.request ?? (async () => o.native ?? status));
  const installBuiltInTool = vi.fn(o.install ?? (async () => ({ started: true })));
  const builtInsStatus = vi.fn((o.built ?? (async () => rows())) as () => Promise<BuiltInsStatusResult>);
  await act(async () => { renderer = create(React.createElement(ComputerUseCard, { request, builtInsStatus, installBuiltInTool })); await vi.advanceTimersByTimeAsync(0); });
  return { request, installBuiltInTool, builtInsStatus };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { act(() => { renderer?.unmount(); }); renderer = null; vi.useRealTimers(); });

describe("ComputerUseCard — Chimera-managed built-in integrations", () => {
  it("lists all three as Built-in, each with its own state, and says Laya's packages download on first use", async () => {
    await mount({});
    for (const id of ["laya", "chimera-browser", "chimera-desktop"]) expect(textOf(row(id))).toContain("Built-in");
    expect(textOf(row("chimera-browser"))).toContain("Ready · v0.0.83");
    expect(textOf(row("laya"))).toContain("Not installed · v0.3.27");
    expect(textOf(row("laya"))).toContain("download on first use");
    expect(text()).not.toContain("Install the Computer Use integration");
  });

  it("offers Laya's first-use install, starts it through the daemon and refreshes", async () => {
    let installed = false;
    const m = await mount({ built: async () => rows(installed ? { laya: { state: "installing", reason: undefined } } : {}), install: async () => { installed = true; return { started: true }; } });
    await act(async () => { button("Install Laya")!.props.onClick(); await vi.advanceTimersByTimeAsync(0); });
    expect(m.installBuiltInTool).toHaveBeenCalledWith("laya");
    expect(textOf(row("laya"))).toContain("Installing…");
    expect(button("Install Laya")).toBeUndefined();
    expect(textOf(row("laya"))).toContain("Downloading");
  });

  it("shows a failed install with its reason and a retry, and nothing installable for ready or bundled rows", async () => {
    await mount({ built: async () => rows({ laya: { state: "failed", reason: "No matching distribution found for torch" } }) });
    expect(textOf(row("laya"))).toContain("Install failed");
    expect(textOf(row("laya"))).toContain("No matching distribution found for torch");
    expect(button("Retry Laya install")).toBeDefined();
    expect(button("Install Laya")).toBeUndefined();
    expect(root().findAll(n => n.type === "button" && /Install/.test(textOf(n)) && !/Laya/.test(textOf(n)))).toHaveLength(0);
  });

  it("surfaces an install RPC error in place", async () => {
    await mount({ install: async () => { throw new Error("Laya is not available on this platform."); } });
    await act(async () => { button("Install Laya")!.props.onClick(); await vi.advanceTimersByTimeAsync(0); });
    expect(root().findAll(n => n.props.role === "alert").map(textOf).join()).toContain("not available on this platform");
  });

  it("explains an unsupported desktop driver instead of asking the user to install something", async () => {
    await mount({
      native: { ...status, configured: false, accessibility: null, screenRecording: null },
      built: async () => rows({ "chimera-desktop": { state: "unsupported-platform", reason: "Chimera hosts desktop control only in its macOS app in this release." } }),
    });
    expect(root().findAll(n => n.props.role === "status").map(textOf).join()).toContain("Not supported");
    expect(text()).toContain("only in its macOS app");
    expect(text()).not.toContain("Setup required");
  });

  it("tells the user to reinstall when the bundled driver file is missing", async () => {
    await mount({
      native: { ...status, configured: false },
      built: async () => rows({ "chimera-desktop": { state: "unavailable", reason: "Bundled file missing: integrations/cua-driver/cua-driver. Reinstall Chimera to restore it." } }),
    });
    expect(root().findAll(n => n.props.role === "status").map(textOf).join()).toContain("Reinstall required");
    expect(text()).toContain("Reinstall Chimera");
  });

  it("shows no built-in list for an unpackaged (development) daemon, and ignores a malformed or failing status", async () => {
    await mount({ built: async () => ({ managed: false, integrations: [] }) });
    expect(root().findAll(n => n.props["data-built-ins"] !== undefined)).toHaveLength(0);
    act(() => { renderer!.unmount(); }); renderer = null;
    await mount({ built: async () => ({ nope: true }) });
    expect(root().findAll(n => n.props["data-built-ins"] !== undefined)).toHaveLength(0);
    act(() => { renderer!.unmount(); }); renderer = null;
    await mount({ built: async () => { throw new Error("daemon down"); } });
    expect(text()).toContain("Permission owner: Chimera");
  });

  it("keeps native permission state visible when the daemon cannot be reached", async () => {
    await mount({ built: async () => { throw new Error("daemon down"); } });
    expect(text()).toContain("Accessibility: allowed");
    expect(root().findAll(n => n.props["data-built-ins"] !== undefined)).toHaveLength(0);
  });
});


describe("ComputerUseCard — operator browser consent", () => {
  it("requires explicit acknowledgement and supports cancel, grant and revoke", async () => {
    let native = { ...status, running: true, existingProfileAllowed: false, existingProfileActive: false };
    const m = await mount({ request: async (command, args) => {
      if (command === "computer_use_browser_access") native = { ...native, existingProfileAllowed: args?.allowed === true, existingProfileActive: args?.allowed === true };
      return native;
    } });
    expect(m.request.mock.calls.filter(c => c[0] === "computer_use_browser_access")).toHaveLength(0);
    await act(async () => { button("Allow existing browser access")!.props.onClick(); });
    expect(button("Allow and restart desktop control")!.props.disabled).toBe(true);
    await act(async () => { button("Allow and restart desktop control")!.props.onClick(); });
    expect(m.request.mock.calls.filter(c => c[0] === "computer_use_browser_access")).toHaveLength(0);
    await act(async () => { button("Cancel")!.props.onClick(); });
    expect(button("Allow and restart desktop control")).toBeUndefined();
    await act(async () => { button("Allow existing browser access")!.props.onClick(); });
    await act(async () => { root().findAll(n => n.type === "input" && n.props.type === "checkbox")[0]!.props.onChange({target:{checked:true}}); });
    await act(async () => { button("Allow and restart desktop control")!.props.onClick(); });
    expect(m.request).toHaveBeenCalledWith("computer_use_browser_access", {allowed:true});
    expect(text()).toContain("Allowed · active");
    await act(async () => { button("Remove browser access")!.props.onClick(); });
    await act(async () => { button("Remove and restart desktop control")!.props.onClick(); });
    expect(m.request).toHaveBeenCalledWith("computer_use_browser_access", {allowed:false});
    expect(text()).toContain("Not allowed");
    expect(m.request.mock.calls.filter(c => c[0] === "computer_use_permissions" || c[0] === "computer_use_start")).toHaveLength(0);
  });

  it("distinguishes saved intent from a failed restart and offers no implicit escalation", async () => {
    let native = { ...status, running: true, existingProfileAllowed: false, existingProfileActive: false };
    await mount({ request: async command => {
      if (command === "computer_use_browser_access") { native = {...native, running:false, existingProfileAllowed:true}; throw new Error("Driver restart failed"); }
      return native;
    } });
    await act(async () => { button("Allow existing browser access")!.props.onClick(); });
    await act(async () => { root().findAll(n => n.type === "input" && n.props.type === "checkbox")[0]!.props.onChange({target:{checked:true}}); });
    await act(async () => { button("Allow and restart desktop control")!.props.onClick(); });
    expect(text()).toContain("Driver restart failed");
    expect(text()).toContain("Allowed for next start");
    expect(text()).not.toContain("Allowed · active");
    expect(button("Start desktop control")!.props.disabled).toBe(false);
  });

  it("older native hosts do not show an unsupported permission control", async () => {
    await mount({});
    expect(button("Allow existing browser access")).toBeUndefined();
  });
});
