import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async (method: string) => {
    if (method === "daemon.status") return { agents: {}, accounts: [], peers: [] };
    if (method === "config.get") return {};
    return [];
  }),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  setDockBadge: vi.fn(async () => {}),
}));

import { SettingsScreen } from "../src/screens/SettingsScreen";
import { registerActionHandler } from "../src/keymap";
import { getSettingsCommands } from "../src/state/commands.settings";
import { appStore } from "../src/state/store";
import { rpcCall } from "../src/rpc/bridge";

let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("SettingsScreen plugins opener", () => {
  it("dispatches plugins.toggleCard from the host-tools section", () => {
    getSettingsCommands(appStore, rpcCall).setSection("tools");
    act(() => { mounted = create(React.createElement(SettingsScreen)); });
    const handler = vi.fn();
    const dispose = registerActionHandler("plugins.toggleCard", handler);

    const button = mounted!.root.findByProps({ "data-open-plugins": true });
    act(() => button.props.onClick());

    expect(handler).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe("SettingsScreen custom provider entry", () => {
  it("opens a distinct custom-provider form without replacing the account form", () => {
    getSettingsCommands(appStore, rpcCall).setSection("providers");
    act(() => { mounted = create(React.createElement(SettingsScreen)); });

    act(() => mounted!.root.findByProps({ "data-add-custom-provider": true }).props.onClick());

    expect(mounted!.root.findAllByProps({ "data-custom-provider-form": true })).toHaveLength(1);
    expect(mounted!.root.findAllByProps({ "data-add-form": true })).toHaveLength(0);
  });
});
