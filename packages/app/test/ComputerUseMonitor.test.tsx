import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import type { McpStoreMonitor } from "@chimera/protocol";

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

import { ComputerUseMonitor } from "../src/components/ComputerUseMonitor";
import { ComputerUseCard } from "../src/components/ComputerUseCard";

type Activity = McpStoreMonitor["activities"][number];
const activity = (id: number, agentId: string, tool = "click", state: Activity["state"] = "succeeded"): Activity => ({ id, ts: 1000 + id, agentId, tool, state });

/** A scriptable desktop: the lease the daemon reports plus what the Rust side would answer. */
function desktop() {
  const world = {
    running: true,
    monitor: { held: true, owner: "agent-a", busy: false, windowId: 11, activities: [] as Activity[] } as McpStoreMonitor,
    previewFails: false,
    deferPreviews: false,
    pending: [] as { windowId: unknown; resolve: (v: string) => void }[],
    calls: [] as { command: string; args?: Record<string, unknown> }[],
  };
  const request = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    world.calls.push({ command, args });
    if (command === "computer_use_status") return { configured: true, running: world.running, autoStart: true, permissionOwner: "Chimera", accessibility: true, screenRecording: true };
    if (command === "computer_use_stop") { world.running = false; return { configured: true, running: false, autoStart: false }; }
    if (command === "computer_use_preview") {
      if (world.previewFails) throw new Error("Target window is unavailable");
      if (world.deferPreviews) return new Promise<string>(resolve => world.pending.push({ windowId: args?.windowId, resolve }));
      return `frame:${String(args?.windowId ?? "desktop")}`;
    }
    throw new Error(`unexpected native command ${command}`);
  });
  const read = vi.fn(async () => world.monitor);
  const count = (command: string) => world.calls.filter(c => c.command === command).length;
  return { world, request, read, count };
}

let renderer: ReturnType<typeof create> | null = null;
const root = (): ReactTestInstance => renderer!.root;
const host = (type: string, label: string): ReactTestInstance | undefined =>
  root().findAll(n => n.type === type && n.props["aria-label"] === label)[0];
const button = (label: string) => host("button", label);
const text = (): string => JSON.stringify(renderer!.toJSON());
const img = (): string | undefined => root().findAll(n => n.type === "img")[0]?.props.src;
const click = (label: string) => act(async () => { button(label)!.props.onClick(); });
const tick = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function mount(d: ReturnType<typeof desktop>, agentId: string | null) {
  const element = (id: string | null) => React.createElement(ComputerUseMonitor, { agentId: id, request: d.request, read: d.read });
  return {
    async render(id: string | null = agentId) {
      await act(async () => {
        if (renderer) renderer.update(element(id)); else renderer = create(element(id));
        await vi.advanceTimersByTimeAsync(0);
      });
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = null;
  vi.useRealTimers();
});

describe("ComputerUseMonitor — in-transcript desktop preview", () => {
  it("shows nothing and never captures the screen for a transcript that does not hold the lease", async () => {
    const d = desktop();
    await mount(d, "agent-b").render();
    await tick(3000);
    expect(renderer!.toJSON()).toBeNull();
    expect(d.count("computer_use_preview")).toBe(0);
  });

  it("shows the frame and only the controlling agent's recent actions for the matching transcript", async () => {
    const d = desktop();
    d.world.monitor.activities = [activity(1, "agent-b", "type_text"), activity(2, "agent-a", "click"), activity(3, "agent-a", "screenshot", "failed")];
    await mount(d, "agent-a").render();
    expect(img()).toBe("frame:11");
    const t = text();
    expect(t).toContain("click");
    expect(t).toContain("screenshot");
    expect(t).not.toContain("type_text");
  });

  it("never leaks agent A's late frame into B's transcript when the selection changes mid-capture", async () => {
    const d = desktop();
    d.world.deferPreviews = true;
    const view = mount(d, "agent-a");
    await view.render("agent-a");
    expect(d.world.pending).toHaveLength(1);                       // A's capture is in flight
    await view.render("agent-b");                                    // user switches transcript
    expect(renderer!.toJSON()).toBeNull();
    d.world.monitor = { ...d.world.monitor, owner: "agent-b", windowId: 22 };
    await tick(1000);                                                // lease now belongs to B (the matching owner)
    await act(async () => { d.world.pending[0]!.resolve("late-frame-of-A"); });   // A's promise settles late
    expect(text()).not.toContain("late-frame-of-A");
    expect(img()).toBeUndefined();
    await tick(0);
    const forB = d.world.pending.find(p => p.windowId === 22)!;
    expect(forB).toBeDefined();                                      // B got its own capture, A's was not reused
    await act(async () => { forB.resolve("frame-of-B"); });
    expect(img()).toBe("frame-of-B");
  });

  it("drops a stale frame when the same transcript's window target changes under it", async () => {
    const d = desktop();
    d.world.deferPreviews = true;
    await mount(d, "agent-a").render();
    d.world.monitor = { ...d.world.monitor, windowId: 99 };
    await tick(1000);
    await act(async () => { d.world.pending[0]!.resolve("old-window-frame"); });
    expect(img()).toBeUndefined();
    expect(text()).not.toContain("old-window-frame");
  });

  it("disappears and stops capturing when the lease is released, without ever calling stop", async () => {
    const d = desktop();
    await mount(d, "agent-a").render();
    expect(img()).toBe("frame:11");
    d.world.monitor = { held: false, owner: null, busy: false, windowId: null, activities: [] };
    await tick(1000);
    expect(renderer!.toJSON()).toBeNull();
    const captures = d.count("computer_use_preview");
    await tick(3000);
    expect(d.count("computer_use_preview")).toBe(captures);
    expect(d.count("computer_use_stop")).toBe(0);
  });

  it("clears the previous frame when capture fails instead of showing a stale one", async () => {
    const d = desktop();
    await mount(d, "agent-a").render();
    expect(img()).toBe("frame:11");
    d.world.previewFails = true;
    await tick(1000);
    expect(img()).toBeUndefined();
    expect(text()).toContain("Target window is unavailable");
  });

  it("stops control explicitly: calls the stop service, removes the overlay, and a late poll cannot bring it back", async () => {
    const d = desktop();
    await mount(d, "agent-a").render();
    const stop = root().findAll(n => n.type === "button" && JSON.stringify(n.children).includes("Stop desktop control"))[0]!;
    await act(async () => { stop.props.onClick(); });
    expect(d.count("computer_use_stop")).toBe(1);
    expect(renderer!.toJSON()).toBeNull();
    const reads = d.read.mock.calls.length;
    await tick(3000);
    expect(renderer!.toJSON()).toBeNull();
    expect(d.read.mock.calls.length).toBe(reads);   // native status says stopped → no further daemon reads
    expect(d.world.running).toBe(false);
  });

  it("collapse only pauses capturing; hide leaves a reopen control; neither stops control", async () => {
    const d = desktop();
    await mount(d, "agent-a").render();
    const live = d.count("computer_use_preview");
    expect(live).toBeGreaterThan(0);

    await click("Collapse desktop preview");
    expect(button("Expand desktop preview")!.props["aria-expanded"]).toBe(false);
    expect(img()).toBeUndefined();
    const paused = d.count("computer_use_preview");
    await tick(3000);
    expect(d.count("computer_use_preview")).toBe(paused);

    await click("Expand desktop preview");
    await tick(1000);
    expect(d.count("computer_use_preview")).toBeGreaterThan(paused);

    await click("Hide desktop preview");
    expect(button("Hide desktop preview")).toBeUndefined();
    const reopen = root().findAll(n => n.type === "button" && "data-computer-monitor-reopen" in n.props)[0];
    expect(reopen).toBeDefined();
    const hidden = d.count("computer_use_preview");
    await tick(3000);
    expect(d.count("computer_use_preview")).toBe(hidden);

    await act(async () => { reopen!.props.onClick(); });
    await tick(1000);
    expect(img()).toBe("frame:11");
    expect(d.count("computer_use_stop")).toBe(0);
  });

  it("a dismissal belongs to one lease: after the holder lets go the next lease starts open", async () => {
    const d = desktop();
    await mount(d, "agent-a").render();
    await click("Hide desktop preview");
    expect(button("Hide desktop preview")).toBeUndefined();
    const held = d.world.monitor;
    d.world.monitor = { held: false, owner: null, busy: false, windowId: null, activities: [] };
    await tick(1000);
    d.world.monitor = held;
    await tick(1000);
    expect(button("Hide desktop preview")).toBeDefined();
    expect(img()).toBe("frame:11");
  });

  it("only ever asks the native side for status, preview and stop — never a window or a start", async () => {
    const d = desktop();
    await mount(d, "agent-a").render();
    await click("Hide desktop preview");
    await tick(2000);
    expect(new Set(d.world.calls.map(c => c.command))).toEqual(new Set(["computer_use_status", "computer_use_preview"]));
  });

  it("does not poll the daemon at all while the desktop driver is stopped", async () => {
    const d = desktop();
    d.world.running = false;
    await mount(d, "agent-a").render();
    await tick(3000);
    expect(d.read).not.toHaveBeenCalled();
    expect(renderer!.toJSON()).toBeNull();
  });
});

describe("ComputerUseCard — Watch desktop activity", () => {
  const status = { configured: true, running: true, autoStart: true, permissionOwner: "Chimera", accessibility: true, screenRecording: true };
  const card = async (monitor: Partial<McpStoreMonitor>, openAgent: (id: string) => boolean) => {
    const commands: string[] = [];
    const request = async (command: string) => { commands.push(command); return status; };
    const read = async (): Promise<McpStoreMonitor> => ({ held: false, owner: null, busy: false, windowId: null, activities: [], ...monitor });
    await act(async () => { renderer = create(React.createElement(ComputerUseCard, { request, read, openAgent })); await vi.advanceTimersByTimeAsync(0); });
    const watch = root().findAll(n => n.type === "button" && JSON.stringify(n.children).includes("Watch desktop activity"))[0]!;
    await act(async () => { watch.props.onClick(); await vi.advanceTimersByTimeAsync(0); });
    return commands;
  };

  it("opens the controlling agent's transcript in the existing app", async () => {
    const open = vi.fn(() => true);
    const commands = await card({ held: true, owner: "agent-a" }, open);
    expect(open).toHaveBeenCalledWith("agent-a");
    expect(commands).not.toContain("computer_use_monitor_open");
    expect(commands).not.toContain("computer_use_start");
  });

  it("explains in place when nobody is controlling the desktop, without navigating or starting anything", async () => {
    const open = vi.fn(() => true);
    const commands = await card({ held: false }, open);
    expect(open).not.toHaveBeenCalled();
    expect(text()).toContain("No agent is controlling the desktop right now");
    expect(commands).not.toContain("computer_use_start");
  });

  it("explains in place when the controlling agent's transcript is not in this app", async () => {
    await card({ held: true, owner: "agent-x", ownerName: "Reviewer" }, () => false);
    expect(text()).toContain("Reviewer is using the desktop");
  });
});
