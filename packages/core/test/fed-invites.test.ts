import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InviteStore, hashToken } from "@chimera/core/federation/invites";

const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `chimera-inv-${tag}-`));

describe("InviteStore", () => {
  it("mints a token, stores ONLY its hash at rest (raw token never on disk)", () => {
    const home = tmp("hash");
    const store = new InviteStore(home);
    const { id, token } = store.create(3600);
    const raw = readFileSync(join(home, "invites.json"), "utf8");
    expect(raw).not.toContain(token);                       // the raw token is NEVER written
    expect(raw).toContain(hashToken(token));                // only its hash is
    expect(store.list().map((r) => r.id)).toContain(id);
    // list never exposes a raw token field
    expect(JSON.stringify(store.list())).not.toContain(token);
  });

  it("is single-use: a valid token checks true once, then burn() makes it fail", () => {
    const store = new InviteStore(tmp("single"));
    const { token } = store.create(3600);
    expect(store.check(token)).toBe(true);
    expect(store.burn(token)).toBe(true);
    expect(store.check(token)).toBe(false);                 // burned → rejected on second use
    expect(store.burn(token)).toBe(false);                  // already burned
  });

  it("enforces TTL: an expired invite fails check()", () => {
    let now = 1_000_000;
    const store = new InviteStore(tmp("ttl"), () => now);
    const { token } = store.create(10);                     // exp = now + 10s
    expect(store.check(token)).toBe(true);
    now += 9_000;
    expect(store.check(token)).toBe(true);
    now += 2_000;                                           // 11s elapsed → past exp
    expect(store.check(token)).toBe(false);
  });

  it("revoke removes an invite by id; survives a restart", () => {
    const home = tmp("revoke");
    const s1 = new InviteStore(home);
    const { id, token } = s1.create(3600);
    expect(s1.revoke(id)).toBe(true);
    expect(s1.check(token)).toBe(false);
    expect(s1.revoke("nope")).toBe(false);
    const s2 = new InviteStore(home);                       // reload from disk
    expect(s2.list().find((r) => r.id === id)).toBeUndefined();
  });

  it("an unknown token never validates", () => {
    const store = new InviteStore(tmp("unknown"));
    store.create(3600);
    expect(store.check("not-a-real-token")).toBe(false);
  });
});
