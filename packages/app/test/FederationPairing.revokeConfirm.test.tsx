import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

const inviteEntry = { id: "inv-1", hash: "h", exp: Date.now() + 60_000, used: false, createdAt: Date.now() };

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async (method: string) => {
    if (method === "fed.invite.list") return { invites: [inviteEntry] };
    if (method === "fed.invite.revoke") return {};
    if (method === "fed.peer.list") return { peers: [] };
    if (method === "config.get") return {};
    if (method === "accounts.list") return { accounts: [] };
    return {};
  }),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  subscribeEvents: vi.fn(async () => {}),
}));

import { FederationPairing } from "../src/components/FederationPairing";
import { rpcCall as rpcCallMock } from "../src/rpc/bridge";

let mounted: ReturnType<typeof create> | null = null;

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  vi.mocked(rpcCallMock).mockClear();
});

// REVOKE-CONFIRM regression: revoking an invite is destructive (its token
// becomes permanently unusable) — a bare click/hotkey must NOT fire
// fed.invite.revoke; it must only fire after the ConfirmCard's explicit confirm.
describe("FederationPairing revoke confirm gate", () => {
  it("does not revoke on a bare row-button click, only after confirming", async () => {
    await act(async () => {
      mounted = create(React.createElement(FederationPairing, { engineId: "e-1" }));
    });
    await act(async () => {}); // flush loadAll()

    const revokeBtn = mounted!.root.findByProps({ "data-invite-revoke": "inv-1" });
    act(() => { revokeBtn.props.onClick({ stopPropagation: () => {} }); });

    expect(rpcCallMock).not.toHaveBeenCalledWith("fed.invite.revoke", expect.anything());

    const confirmChip = mounted!.root.findByProps({ "data-confirm": true });
    await act(async () => { confirmChip.props.onClick(); });

    expect(rpcCallMock).toHaveBeenCalledWith("fed.invite.revoke", { id: "inv-1" });
  });
});
