import { describe, expect, it } from "vitest";
import { encodePairBlob, type InviteListEntry, type FedJoinResult } from "@chimera/protocol";
import {
  blobPreview,
  projectJoin,
  stepVisual,
  joinError,
  derivePeerRows,
  isGranted,
  normalizeGrant,
  buildGrantParams,
  toggleGrantAccount,
  deriveInviteRows,
  inviteRowState,
  fmtExp,
  type PeerGrantConfig,
  type PeerStatusSnapshot,
} from "../src/state/selectors.federation";

// W10 gate (F10 · B15): the pure decision layer behind the pairing UI. The
// load-bearing security property — a decoded blob NEVER surfaces its token —
// is asserted first.

const RAW_TOKEN = "9f3a71c2b8e4d5f60112233445566778"; // 128-bit-ish bearer secret
const NOW = 1_000_000;

function makeBlob(engineId = "studio", host = "100.86.12.4", exp = NOW + 14 * 60_000): string {
  return encodePairBlob({
    card: { engineId, protocolVersion: 1, features: ["federation.v1"], providers: ["claude"], accounts: [{ name: "main", provider: "claude" }], publicKey: "pk-base64" },
    endpoint: { socketPath: "/home/x/.chimera/federation.sock", ssh: { host, remoteSocket: ".chimera/federation.sock" } },
    inviteToken: RAW_TOKEN,
    exp,
  });
}

describe("blobPreview — decode without exposing the token", () => {
  it("returns engine / endpoint / expiry and NEVER the token", () => {
    const blob = makeBlob();
    const view = blobPreview(blob, NOW);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.engineId).toBe("studio");
    expect(view.endpointLabel).toBe("100.86.12.4"); // ssh host preferred over socketPath
    expect(view.expired).toBe(false);
    // the token must appear in NO field of the preview
    expect(JSON.stringify(view)).not.toContain(RAW_TOKEN);
  });

  it("flags an expired blob without erroring", () => {
    const view = blobPreview(makeBlob("studio", "1.2.3.4", NOW - 1), NOW);
    expect(view.ok).toBe(true);
    if (view.ok) expect(view.expired).toBe(true);
  });

  it("returns a protocol error on a malformed blob (no throw)", () => {
    const view = blobPreview("not-a-pair-blob", NOW);
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.error).toMatch(/chimera-pair/);
  });

  it("prompts on empty input", () => {
    const view = blobPreview("   ", NOW);
    expect(view.ok).toBe(false);
  });
});

describe("projectJoin — step indicator", () => {
  it("all pending before any attempt", () => {
    const steps = projectJoin(null, false);
    expect(steps.map((s) => s.status)).toEqual(["pending", "pending", "pending", "pending", "pending"]);
  });

  it("first step active while joining", () => {
    const steps = projectJoin(null, true);
    expect(steps[0]!.status).toBe("active");
    expect(steps.slice(1).every((s) => s.status === "pending")).toBe(true);
  });

  it("maps a partial failure: done up to the failing step, failed there, pending after", () => {
    const result: FedJoinResult = {
      steps: [
        { step: "config", ok: true },
        { step: "sshkeys", ok: true },
        { step: "tunnel", ok: true },
        { step: "handshake", ok: false, error: "peer-auth: token burned" },
      ],
      paired: null,
    };
    const steps = projectJoin(result, false);
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "done", "failed", "pending"]);
    expect(joinError(steps)).toBe("peer-auth: token burned");
  });

  it("all done on a clean pairing", () => {
    const result: FedJoinResult = {
      steps: [
        { step: "config", ok: true }, { step: "sshkeys", ok: true }, { step: "tunnel", ok: true },
        { step: "handshake", ok: true }, { step: "paired", ok: true },
      ],
      paired: "studio",
    };
    expect(projectJoin(result, false).every((s) => s.status === "done")).toBe(true);
    expect(joinError(projectJoin(result, false))).toBeNull();
  });

  it("skips the ssh-bootstrap step entirely for a same-host/loopback join (§13: additive, unreported when absent)", () => {
    const result: FedJoinResult = {
      steps: [
        { step: "config", ok: true }, { step: "tunnel", ok: true },
        { step: "handshake", ok: true }, { step: "paired", ok: true },
      ],
      paired: "studio",
    };
    const steps = projectJoin(result, false);
    expect(steps.map((s) => s.status)).toEqual(["done", "pending", "done", "done", "done"]);
  });

  it("stepVisual: comet only on the active step", () => {
    expect(stepVisual("active").comet).toBe(true);
    expect(stepVisual("done").comet).toBe(false);
    expect(stepVisual("failed").tone).toBe("danger");
  });
});

describe("derivePeerRows — state derivation", () => {
  const granted: PeerGrantConfig = { engineId: "studio", allowSpawn: true, accounts: ["main", "second"], maxConcurrent: 4, ssh: { host: "100.86.12.4" } };
  const readonlyPeer: PeerGrantConfig = { engineId: "attic", allowSpawn: false, accounts: [], maxConcurrent: 4 };

  it("granted peer → paired · granted with the grants label", () => {
    const snap: PeerStatusSnapshot = { engineId: "studio", state: "connected", outboxPending: 0 };
    const [row] = derivePeerRows([granted], [snap], [], NOW);
    expect(row!.state).toBe("granted");
    expect(row!.stateLabel).toBe("paired · granted");
    expect(row!.grantsLabel).toBe("spawn on · accounts main,second · max 4");
    expect(row!.ip).toBe("100.86.12.4");
    expect(row!.grantable).toBe(true);
  });

  it("read-only peer → paired, read-only grants label", () => {
    const [row] = derivePeerRows([readonlyPeer], [], [], NOW);
    expect(row!.state).toBe("paired");
    expect(row!.grantsLabel).toBe("read-only");
  });

  it("partitioned link → partitioned (danger) + carries the outbox count", () => {
    const snap: PeerStatusSnapshot = { engineId: "studio", state: "partitioned", outboxPending: 3 };
    const [row] = derivePeerRows([granted], [snap], [], NOW);
    expect(row!.state).toBe("partitioned");
    expect(row!.stateTone).toBe("danger");
    expect(row!.outboxPending).toBe(3);
  });

  it("active invite → a pending-invite row; used/expired invites do not", () => {
    const invites: InviteListEntry[] = [
      { id: "i1", hash: "h", exp: NOW + 60_000, used: false, createdAt: NOW },      // active → row
      { id: "i2", hash: "h", exp: NOW + 60_000, used: true, createdAt: NOW },       // used → no row
      { id: "i3", hash: "h", exp: NOW - 1, used: false, createdAt: NOW },           // expired → no row
    ];
    const rows = derivePeerRows([], [], invites, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("pending-invite");
    expect(rows[0]!.grantable).toBe(false);
    expect(rows[0]!.engineId).toBeNull();
  });
});

describe("grant helpers", () => {
  it("isGranted: allowSpawn AND a non-empty account grant", () => {
    expect(isGranted({ allowSpawn: true, accounts: "auto" })).toBe(true);
    expect(isGranted({ allowSpawn: true, accounts: ["main"] })).toBe(true);
    expect(isGranted({ allowSpawn: true, accounts: [] })).toBe(false);
    expect(isGranted({ allowSpawn: false, accounts: "auto" })).toBe(false);
  });

  it("normalizeGrant defaults maxConcurrent to 4 and coerces accounts", () => {
    expect(normalizeGrant(undefined)).toEqual({ allowSpawn: false, accounts: [], maxConcurrent: 4 });
    expect(normalizeGrant({ engineId: "x", allowSpawn: true, accounts: "auto", maxConcurrent: 8 }))
      .toEqual({ allowSpawn: true, accounts: "auto", maxConcurrent: 8 });
  });

  it("buildGrantParams clamps maxConcurrent to a positive int and carries engineId", () => {
    expect(buildGrantParams("studio", { allowSpawn: true, accounts: ["main"], maxConcurrent: 0 }))
      .toEqual({ engineId: "studio", allowSpawn: true, accounts: ["main"], maxConcurrent: 1 });
  });

  it("toggleGrantAccount switches auto→explicit and toggles names", () => {
    expect(toggleGrantAccount("auto", "main")).toEqual(["main"]);
    expect(toggleGrantAccount(["main"], "second")).toEqual(["main", "second"]);
    expect(toggleGrantAccount(["main", "second"], "main")).toEqual(["second"]);
  });
});

describe("invite rows + exp", () => {
  it("inviteRowState: used > expired > active precedence", () => {
    expect(inviteRowState({ id: "i", hash: "h", exp: NOW + 1, used: true, createdAt: 0 }, NOW)).toBe("used");
    expect(inviteRowState({ id: "i", hash: "h", exp: NOW - 1, used: false, createdAt: 0 }, NOW)).toBe("expired");
    expect(inviteRowState({ id: "i", hash: "h", exp: NOW + 1, used: false, createdAt: 0 }, NOW)).toBe("active");
  });

  it("deriveInviteRows sorts newest first and marks revocable only for active", () => {
    const entries: InviteListEntry[] = [
      { id: "old", hash: "h", exp: NOW + 60_000, used: false, createdAt: NOW - 10_000 },
      { id: "new", hash: "h", exp: NOW + 60_000, used: false, createdAt: NOW },
      { id: "spent", hash: "h", exp: NOW + 60_000, used: true, createdAt: NOW - 5_000 },
    ];
    const rows = deriveInviteRows(entries, NOW);
    expect(rows.map((r) => r.id)).toEqual(["new", "spent", "old"]);
    expect(rows.find((r) => r.id === "spent")!.revocable).toBe(false);
    expect(rows.find((r) => r.id === "new")!.revocable).toBe(true);
  });

  it("fmtExp: minutes remaining, then expired", () => {
    expect(fmtExp(NOW + 14 * 60_000, NOW)).toMatch(/\(14m\)$/);
    expect(fmtExp(NOW + 30_000, NOW)).toMatch(/\(<1m\)$/);
    expect(fmtExp(NOW - 1, NOW)).toMatch(/\(expired\)$/);
  });
});
