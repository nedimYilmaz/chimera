import { describe, expect, it } from "vitest";
import type { UiStore } from "@chimera/ui-state";
import { createFederationCommands } from "../src/state/commands.federation";

// W10 gate (F10 · B15), commands half: the pairing command layer sends the
// exact RPC params D8 expects, holds the invite blob transiently ONLY for the
// copy row, and self-refreshes off daemon events. The load-bearing property —
// fed.invite.list carries HASHES, so the store never holds a raw token — is
// covered by the daemon contract; here we assert the store never surfaces one.

type Call = { method: string; params: unknown };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function harness(handlers: Record<string, (params: unknown) => unknown> = {}) {
  const calls: Call[] = [];
  const dispatched: unknown[] = [];
  const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
  const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    const h = handlers[method];
    if (h) return Promise.resolve(h(params) as T);
    return Promise.reject({ code: "protocol", message: `unknown method "${method}"` });
  };
  const cmds = createFederationCommands(store, request);
  return { cmds, calls, dispatched };
}

const INVITE_LIST = { invites: [{ id: "i1", hash: "sha256-hash", exp: 2_000_000, used: false, createdAt: 1_000_000 }] };

describe("createInvite", () => {
  it("holds the returned blob transiently and refreshes the list", async () => {
    const blob = "chimera-pair:v1;eyJ4Ijoxfq==";
    const h = harness({
      "fed.invite.create": () => ({ id: "i1", blob, exp: 2_000_000 }),
      "fed.invite.list": () => INVITE_LIST,
    });
    const returned = await h.cmds.createInvite(3600);
    expect(returned).toBe(blob);
    expect(h.cmds.getState().lastBlob).toBe(blob);
    expect(h.calls.find((c) => c.method === "fed.invite.create")!.params).toEqual({ ttlSeconds: 3600 });
    expect(h.calls.some((c) => c.method === "fed.invite.list")).toBe(true);
    expect(h.cmds.getState().invites).toHaveLength(1);
  });

  it("omits ttlSeconds when not given (daemon default applies)", async () => {
    const h = harness({ "fed.invite.create": () => ({ id: "i", blob: "b", exp: 1 }), "fed.invite.list": () => INVITE_LIST });
    await h.cmds.createInvite();
    expect(h.calls.find((c) => c.method === "fed.invite.create")!.params).toEqual({});
  });

  it("clearBlob drops the transient blob", async () => {
    const h = harness({ "fed.invite.create": () => ({ id: "i", blob: "b", exp: 1 }), "fed.invite.list": () => INVITE_LIST });
    await h.cmds.createInvite();
    h.cmds.clearBlob();
    expect(h.cmds.getState().lastBlob).toBeNull();
  });
});

describe("loadInvites — never carries a raw token", () => {
  it("the store only ever holds the hash the list returns", async () => {
    const h = harness({ "fed.invite.list": () => INVITE_LIST });
    await h.cmds.loadInvites();
    const snapshot = JSON.stringify(h.cmds.getState());
    expect(snapshot).toContain("sha256-hash");
    // no field named inviteToken / token is ever present in the invite carriage
    expect(h.cmds.getState().invites[0]).not.toHaveProperty("inviteToken");
  });
});

describe("loadPeers — merges peer.status + config.get, tolerant of one failing", () => {
  it("reads runtime snapshots and grant config", async () => {
    const h = harness({
      "peer.status": () => ({ peers: [{ engineId: "studio", state: "connected", outboxPending: 2, hostTools: { host: "studio", tools: [] } }] }),
      "config.get": () => ({ federation: { peers: [{ engineId: "studio", allowSpawn: true, accounts: ["main"], maxConcurrent: 4, ssh: { host: "100.86.12.4" } }] } }),
    });
    await h.cmds.loadPeers();
    expect(h.cmds.getState().peers).toHaveLength(1);
    expect(h.cmds.getState().peers[0]!.state).toBe("connected");
    expect(h.cmds.getState().configPeers[0]!.allowSpawn).toBe(true);
    expect(h.cmds.getState().configPeers[0]!.ssh?.host).toBe("100.86.12.4");
  });

  it("a peer.status failure keeps config peers (allSettled)", async () => {
    const h = harness({ "config.get": () => ({ federation: { peers: [{ engineId: "studio" }] } }) });
    await h.cmds.loadPeers();
    expect(h.cmds.getState().configPeers).toHaveLength(1);
    expect(h.cmds.getState().peers).toHaveLength(0);
    expect(h.dispatched.some((d) => (d as { type?: string }).type === "commandError")).toBe(true);
  });
});

describe("join", () => {
  it("sends the blob, stores the step result, and reloads peers", async () => {
    const result = { steps: [{ step: "config", ok: true }, { step: "paired", ok: true }], paired: "studio" };
    const h = harness({
      "fed.join": () => result,
      "peer.status": () => ({ peers: [] }),
      "config.get": () => ({}),
    });
    const returned = await h.cmds.join("  chimera-pair:v1;blob  ");
    expect(returned).toEqual(result);
    expect(h.calls.find((c) => c.method === "fed.join")!.params).toEqual({ blob: "chimera-pair:v1;blob" });
    expect(h.cmds.getState().joinResult).toEqual(result);
    expect(h.cmds.getState().joining).toBe(false);
    expect(h.calls.some((c) => c.method === "peer.status")).toBe(true);
  });

  it("a join failure clears the joining flag and toasts", async () => {
    const h = harness({}); // fed.join rejects → protocol error
    const returned = await h.cmds.join("blob");
    expect(returned).toBeNull();
    expect(h.cmds.getState().joining).toBe(false);
    expect(h.dispatched.some((d) => (d as { type?: string }).type === "commandError")).toBe(true);
  });
});

describe("grant", () => {
  it("sends buildGrantParams and reloads peers", async () => {
    const h = harness({ "fed.peer.grant": () => ({ ok: true }), "peer.status": () => ({ peers: [] }), "config.get": () => ({}) });
    const ok = await h.cmds.grant("studio", { allowSpawn: true, accounts: ["main"], maxConcurrent: 6 });
    expect(ok).toBe(true);
    expect(h.calls.find((c) => c.method === "fed.peer.grant")!.params)
      .toEqual({ engineId: "studio", allowSpawn: true, accounts: ["main"], maxConcurrent: 6 });
  });
});

describe("onDaemonEvent — self-refresh", () => {
  it("peer_paired refetches peers + invites", async () => {
    const h = harness({ "peer.status": () => ({ peers: [] }), "config.get": () => ({}), "fed.invite.list": () => INVITE_LIST });
    h.cmds.onDaemonEvent("peer_paired");
    await settle();
    expect(h.calls.some((c) => c.method === "peer.status")).toBe(true);
    expect(h.calls.some((c) => c.method === "fed.invite.list")).toBe(true);
  });

  it("network_changed refetches peers only", async () => {
    const h = harness({ "peer.status": () => ({ peers: [] }), "config.get": () => ({}) });
    h.cmds.onDaemonEvent("network_changed");
    await settle();
    expect(h.calls.some((c) => c.method === "peer.status")).toBe(true);
    expect(h.calls.some((c) => c.method === "fed.invite.list")).toBe(false);
  });
});
