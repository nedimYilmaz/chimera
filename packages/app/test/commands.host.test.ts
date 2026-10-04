import { describe, expect, it } from "vitest";
import type { UiStore } from "@chimera/ui-state";
import { createHostCommands } from "../src/state/commands.host";
import type { HostToolsReply } from "../src/state/selectors.host";

// W8 gate (a), commands half: the card's open/select/cycle transitions send
// EXACTLY the params the engine's HostSetPolicyParams expects
// ({tool, profile, mode} — profile "*" is the wildcard row, engine.ts:132),
// mutations render optimistically and reconcile from the next host.tools
// fetch, and remote rows are never mutation targets.

type Call = { method: string; params: unknown };

function harness(reply: () => HostToolsReply) {
  const calls: Call[] = [];
  const dispatched: unknown[] = [];
  const store = { dispatch: (a: unknown) => dispatched.push(a) } as unknown as UiStore;
  const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === "host.tools") return Promise.resolve(reply() as unknown as T);
    if (method === "host.setPolicy") return Promise.resolve({} as T);
    return Promise.reject(new Error(`unexpected method ${method}`));
  };
  const cmds = createHostCommands(store, request, () => 1_000);
  return { cmds, calls, dispatched };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const local = (policy: Record<string, Record<string, string>> = {}): HostToolsReply => ({
  host: "mbp",
  tools: [
    { tool: "kubectl", version: "1.31", profiles: ["prod", "staging"], policy: policy["kubectl"] ?? {} },
    { tool: "gh", version: "2.55", profiles: ["alice"], policy: policy["gh"] ?? {} },
    { tool: "docker", version: "27.1", profiles: [], policy: policy["docker"] ?? {} },
  ],
});

describe("toggle / escape (opener re-toggle + esc tiering)", () => {
  it("open fetches host.tools; mod+d re-toggle closes", async () => {
    const h = harness(local);
    h.cmds.toggle();
    await settle();
    expect(h.cmds.getState().open).toBe(true);
    expect(h.calls.filter((c) => c.method === "host.tools")).toHaveLength(1);
    expect(h.cmds.getState().reply?.host).toBe("mbp");
    expect(h.cmds.getState().fetchedAt).toBe(1_000);   // CLIENT-side fetch time (no scannedAt on the wire)
    h.cmds.toggle();
    expect(h.cmds.getState().open).toBe(false);
  });
  it("esc exits profile-edit first, then closes", async () => {
    const h = harness(local);
    h.cmds.toggle();
    await settle();
    h.cmds.profileEdit();
    expect(h.cmds.getState().profileCursor).toBe(0);
    h.cmds.escape();
    expect(h.cmds.getState().profileCursor).toBeNull();
    expect(h.cmds.getState().open).toBe(true);
    h.cmds.escape();
    expect(h.cmds.getState().open).toBe(false);
  });
});

describe("wildcard cycle (space) — exact engine params + optimistic reconcile", () => {
  it("sends {tool:'kubectl', profile:'*', mode:'ask'} from an unset policy", async () => {
    const h = harness(local);
    h.cmds.toggle();
    await settle();
    await h.cmds.cycle();                               // selected row 0 = kubectl
    const set = h.calls.filter((c) => c.method === "host.setPolicy");
    expect(set).toEqual([{ method: "host.setPolicy", params: { tool: "kubectl", profile: "*", mode: "ask" } }]);
    // reconcile: the mutation triggered the NEXT host.tools fetch
    expect(h.calls.filter((c) => c.method === "host.tools")).toHaveLength(2);
  });
  it("cycles ask → deny (the real-RPC gate's exact write)", async () => {
    const h = harness(() => local({ kubectl: { "*": "ask" } }));
    h.cmds.toggle();
    await settle();
    await h.cmds.cycle();
    expect(h.calls.filter((c) => c.method === "host.setPolicy")).toEqual([
      { method: "host.setPolicy", params: { tool: "kubectl", profile: "*", mode: "deny" } },
    ]);
  });
  it("applies optimistically before the daemon confirms", async () => {
    let resolveSet: (() => void) | null = null;
    const calls: Call[] = [];
    const store = { dispatch: () => {} } as unknown as UiStore;
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "host.tools") return Promise.resolve(local() as unknown as T);
      return new Promise<T>((r) => { resolveSet = () => r({} as T); });   // hang host.setPolicy
    };
    const cmds = createHostCommands(store, request);
    cmds.toggle();
    await settle();
    const p = cmds.cycle();
    expect(cmds.getState().reply?.tools[0]?.policy["*"]).toBe("ask");     // optimistic, before the RPC settles
    resolveSet!();
    await p;
  });
  it("HOST-TOOLS-PER-ROW: each tool row cycles ONLY its own tool's wildcard", async () => {
    const h = harness(local);
    h.cmds.toggle();
    await settle();
    h.cmds.select(1);                                   // local() rows: [kubectl, gh, docker] — gh
    await h.cmds.cycle();
    expect(h.calls.filter((c) => c.method === "host.setPolicy").map((c) => c.params)).toEqual([
      { tool: "gh", profile: "*", mode: "ask" },
    ]);
  });
});

describe("per-profile edit (p) — cursored profile cycles, not the wildcard", () => {
  it("cursor 0 is the default (*) entry — cycles the wildcard via the p-editor", async () => {
    const h = harness(() => local({ kubectl: { prod: "ask", "*": "allow" } }));
    h.cmds.toggle();
    await settle();
    h.cmds.profileEdit();                               // cursor 0 = kubectl default (*)
    await h.cmds.cycle();
    expect(h.calls.filter((c) => c.method === "host.setPolicy")).toEqual([
      { method: "host.setPolicy", params: { tool: "kubectl", profile: "*", mode: "ask" } },
    ]);
  });
  it("sends the profile-specific write from its EFFECTIVE mode", async () => {
    const h = harness(() => local({ kubectl: { prod: "ask", "*": "allow" } }));
    h.cmds.toggle();
    await settle();
    h.cmds.profileEdit();                               // cursor 0 = default (*)
    h.cmds.moveProfileCursor(1);                         // cursor 1 = kubectl prod
    await h.cmds.cycle();
    expect(h.calls.filter((c) => c.method === "host.setPolicy")).toEqual([
      { method: "host.setPolicy", params: { tool: "kubectl", profile: "prod", mode: "deny" } },
    ]);
  });
  it("moves the inline cursor within bounds (default (*), prod, staging)", async () => {
    const h = harness(local);
    h.cmds.toggle();
    await settle();
    h.cmds.profileEdit();
    expect(h.cmds.getState().profileCursor).toBe(0);    // default (*)
    h.cmds.moveProfileCursor(1);
    expect(h.cmds.getState().profileCursor).toBe(1);    // prod
    h.cmds.moveProfileCursor(1);
    expect(h.cmds.getState().profileCursor).toBe(2);    // staging
    h.cmds.moveProfileCursor(1);
    expect(h.cmds.getState().profileCursor).toBe(2);    // clamped
    h.cmds.moveProfileCursor(-5);
    expect(h.cmds.getState().profileCursor).toBe(0);
  });
  it("p on a tool row with no named profiles still enters the default (*) entry", async () => {
    const h = harness(local);
    h.cmds.toggle();
    await settle();
    h.cmds.select(2);                                   // docker — no named profiles
    h.cmds.profileEdit();
    expect(h.cmds.getState().profileCursor).toBe(0);
    await h.cmds.cycle();
    expect(h.calls.filter((c) => c.method === "host.setPolicy")).toEqual([
      { method: "host.setPolicy", params: { tool: "docker", profile: "*", mode: "ask" } },
    ]);
  });
});

describe("remote rows are NEVER mutation targets (B14 federation rule)", () => {
  it("space and p on a ⇅ peer row send nothing", async () => {
    const h = harness(local);
    h.cmds.toggle();
    await settle();
    // no client RPC carries the peer.status host-tools carriage today —
    // setPeers is the one seeding door (degraded state, PLAN §7 W8)
    h.cmds.setPeers([{ host: "studio", tools: [{ tool: "kubectl", version: "1.30", profiles: ["homelab"], policy: {} }] }]);
    h.cmds.select(3);                                   // rows: kubectl, gh, docker, ⇅ studio
    expect(h.cmds.rows()[3]!.remote).toBe(true);
    await h.cmds.cycle();
    h.cmds.profileEdit();
    expect(h.cmds.getState().profileCursor).toBeNull();
    expect(h.calls.filter((c) => c.method === "host.setPolicy")).toEqual([]);
  });
});

describe("failure path (footer red line, previous rows kept)", () => {
  it("dispatches commandError and keeps the old reply on a failed refresh", async () => {
    let fail = false;
    const dispatched: Array<Record<string, unknown>> = [];
    const store = { dispatch: (a: Record<string, unknown>) => dispatched.push(a) } as unknown as UiStore;
    const request = <T = unknown>(method: string): Promise<T> => {
      if (fail) return Promise.reject({ code: "unknown", message: "daemon down" });
      if (method === "host.tools") return Promise.resolve(local() as unknown as T);
      return Promise.resolve({} as T);
    };
    const cmds = createHostCommands(store, request);
    cmds.toggle();
    await settle();
    expect(cmds.getState().reply).not.toBeNull();
    fail = true;
    await cmds.refresh();
    expect(cmds.getState().reply).not.toBeNull();       // previous rows kept
    expect(dispatched).toContainEqual({ type: "commandError", message: "daemon down" });
  });
});

describe("W10 · F10 — refreshPeers wires the ⇅ carriage onto the live peer.status RPC", () => {
  it("lifts each snapshot's hostTools into the remote rows", async () => {
    const calls: Call[] = [];
    const store = { dispatch: () => {} } as unknown as UiStore;
    const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "host.tools") return Promise.resolve(local() as unknown as T);
      if (method === "peer.status") {
        return Promise.resolve({
          peers: [
            { engineId: "studio", state: "connected", outboxPending: 0, hostTools: { host: "studio", tools: [{ tool: "kubectl", version: "1.30", profiles: ["homelab"], policy: {} }] } },
            { engineId: "attic", state: "partitioned", outboxPending: 3, hostTools: null }, // no scan yet → dropped
          ],
        } as unknown as T);
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    };
    const cmds = createHostCommands(store, request);
    cmds.toggle();                     // opens → fetches host.tools AND peer.status
    await settle();
    expect(calls.some((c) => c.method === "peer.status")).toBe(true);
    const peers = cmds.getState().peers;
    expect(peers).toHaveLength(1);     // the null-hostTools peer is dropped
    expect(peers[0]!.host).toBe("studio");
    // the ⇅ remote row now renders from live data
    const remote = cmds.rows().find((r) => r.remote);
    expect(remote?.hostMark).toBe("⇅ studio");
    expect(remote?.cycleTools).toEqual([]); // still read-only (policy is the peer's)
  });

  it("keeps prior rows when peer.status is unavailable (old/unfederated daemon)", async () => {
    const store = { dispatch: () => {} } as unknown as UiStore;
    const request = <T = unknown>(method: string): Promise<T> => {
      if (method === "host.tools") return Promise.resolve(local() as unknown as T);
      return Promise.reject({ code: "protocol", message: 'unknown method "peer.status"' });
    };
    const cmds = createHostCommands(store, request);
    cmds.setPeers([{ host: "studio", tools: [] }]);
    await cmds.refreshPeers();          // rejects → caught → prior rows kept
    expect(cmds.getState().peers).toHaveLength(1);
  });
});
