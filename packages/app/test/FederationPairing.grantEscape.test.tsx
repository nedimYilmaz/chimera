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
    if (method === "fed.invite.list") return { invites: [] };
    if (method === "fed.peer.list") return { peers: [] };
    if (method === "config.get") {
      return { federation: { peers: [{ engineId: "peer-1", allowSpawn: true, accounts: "auto" }] } };
    }
    if (method === "accounts.list") return { accounts: ["a1"] };
    return {};
  }),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  subscribeEvents: vi.fn(async () => {}),
}));

import { FederationPairing } from "../src/components/FederationPairing";

let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

// GRANT-MENU-ESCAPE regression: the grant menu footer reads "esc cancel" but
// the menu had no Escape handler, so the promised keyboard exit did nothing.
describe("FederationPairing grant menu escape", () => {
  it("closes the grant menu on Escape, matching its own footer hint", async () => {
    await act(async () => {
      mounted = create(React.createElement(FederationPairing, { engineId: "e-1" }));
    });
    await act(async () => {}); // flush loadAll()

    const grantBtn = mounted!.root.findByProps({ "data-peer-grant": "peer-1" });
    act(() => { grantBtn.props.onClick({ stopPropagation: () => {} }); });

    expect(mounted!.root.findAllByProps({ "data-grant-menu": "peer-1" })).toHaveLength(1);

    const menu = mounted!.root.findByProps({ "data-grant-menu": "peer-1" });
    act(() => { menu.props.onKeyDown({ key: "Escape", stopPropagation: () => {} }); });

    expect(mounted!.root.findAllByProps({ "data-grant-menu": "peer-1" })).toHaveLength(0);
  });
});
