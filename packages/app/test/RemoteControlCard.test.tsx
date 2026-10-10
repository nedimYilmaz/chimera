import React from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  apply: vi.fn().mockResolvedValue(undefined), agent: { agentId: "a", state: "running", provider: "codex", remoteControl: { enabled: true, connectionStatus: "connecting", serverName: "my-codex", environmentId: "env-local" } },
}));
vi.mock("../src/state/useStore", () => ({ useStore: (fn: any) => fn({ selectedAgentId: "a", agents: { a: mocks.agent } }) }));
vi.mock("../src/state/store", () => ({ appStore: {} }));
vi.mock("../src/rpc/bridge", () => ({ rpcCall: vi.fn() }));
vi.mock("../src/state/commands.system", () => ({ useSystemLocal: (fn: any) => fn({ remoteControlOpen: true }), systemLocal: { set: vi.fn() }, systemCommands: () => ({ applyRemoteControl: mocks.apply }) }));
vi.mock("../src/components/OverlayOutlet", () => ({ registerOverlay: vi.fn() }));
vi.mock("../src/components/OverlayCard", () => ({ OverlayCard: ({ children }: any) => <div>{children}</div>, OverlayCardHeader: () => <div /> }));
vi.mock("../src/state/selectors", () => ({ displayName: () => "agent" }));
vi.mock("../src/keymap", () => ({ isEditableTarget: () => false }));
import { RemoteControlCard } from "../src/components/RemoteControlCard";
let view: ReturnType<typeof create> | undefined;
beforeEach(() => { vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
afterEach(() => { act(() => view?.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("shows native Codex state/identity without claiming a Claude attach link or voice connection", async () => {
  act(() => { view = create(<RemoteControlCard />); });
  const text = JSON.stringify(view!.toJSON());
  expect(text).toContain("connecting"); expect(text).toContain("my-codex"); expect(text).toContain("env-local");
  expect(text).toContain("not voice"); expect(text).not.toContain("claude.ai");
  expect(view!.root.findAllByProps({ "data-remote-control-url": true })).toHaveLength(0);
  await act(async () => view!.root.findByProps({ "data-remote-control-toggle": true }).props.onClick());
  expect(mocks.apply).toHaveBeenCalledWith("a", false, false);
});
