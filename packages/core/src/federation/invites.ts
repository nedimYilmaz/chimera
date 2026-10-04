import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { InviteListEntry } from "@chimera/protocol";

// D8 (pairing, coverage C7 · B15). The single-use invite ledger. A 128-bit token is minted
// at fed.invite.create and travels ONCE inside the pairing blob the operator copies; only its
// SHA-256 HASH is ever written here (${home}/invites.json). check() peeks (hash + TTL +
// unburned); burn() marks it used after a successful pair — a second presentation fails.
// The raw token NEVER touches disk, an event, or any response but fed.invite.create's blob (D0).

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// keyTag (§13a addendum, optional/additive): when fed.invite.create minted an ephemeral
// ssh-layer keypair for this invite, this is the authorized_keys comment tag
// ("invite-<id>") its public half was installed under — so revoke/expiry-sweep/pairing-retag
// know which line to touch. Absent on a plain (no-Cloudflare-endpoint) invite, unchanged shape.
export type InviteRecord = { id: string; hash: string; exp: number; used: boolean; createdAt: number; keyTag?: string };

export class InviteStore {
  private file: string;
  private records: InviteRecord[];

  constructor(home: string, private now: () => number = Date.now) {
    mkdirSync(home, { recursive: true });
    this.file = join(home, "invites.json");
    this.records = this.load();
  }

  private load(): InviteRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw.filter((r): r is InviteRecord =>
        r && typeof r.id === "string" && typeof r.hash === "string"
        && typeof r.exp === "number" && typeof r.used === "boolean" && typeof r.createdAt === "number");
    } catch {
      return [];   // a torn ledger is not a security hole (a missing invite fails closed → default deny)
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.records, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Mint a token (raw, returned to the caller ONCE) and persist ONLY its hash + TTL. */
  create(ttlSeconds: number): { id: string; token: string; exp: number } {
    const token = randomBytes(16).toString("base64url");   // 128-bit single-use bearer secret
    const id = randomUUID();
    const exp = this.now() + ttlSeconds * 1000;
    this.records.push({ id, hash: hashToken(token), exp, used: false, createdAt: this.now() });
    this.save();
    return { id, token, exp };
  }

  /** hashes/exp/used — NEVER raw tokens (there is no raw token at rest to return). */
  list(): InviteListEntry[] {
    return this.records.map((r) => ({ id: r.id, hash: r.hash, exp: r.exp, used: r.used, createdAt: r.createdAt }));
  }

  /** §13a: record which authorized_keys tag this invite's ephemeral public key was installed
   *  under, so revoke/sweep/retag can find the line later. */
  setKeyTag(id: string, keyTag: string): void {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return;
    rec.keyTag = keyTag;
    this.save();
  }

  /** Look up a record by id without mutating anything (§13a/f: the caller reads `keyTag` before
   *  revoking so it knows which authorized_keys line to remove alongside the invite). */
  get(id: string): InviteRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** Remove an invite by id (operator revoke). Returns true when one was removed — UNCHANGED
   *  shape from pre-§13; call get(id) first if you need its keyTag. */
  revoke(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length !== before) { this.save(); return true; }
    return false;
  }

  /** Peek: does `token` match an UNBURNED, UNEXPIRED invite? (no mutation — burn() commits it). */
  check(token: string): boolean {
    const h = hashToken(token);
    const rec = this.records.find((r) => r.hash === h);
    return !!rec && !rec.used && rec.exp > this.now();
  }

  /** Commit single-use: mark the matching invite burned. Returns true when one was burned. */
  burn(token: string): boolean {
    return this.burnAndGet(token) !== undefined;
  }

  /** Same commit as burn(), but returns the burned record (§13a: onPeerPaired needs `keyTag`
   *  to retag the authorized_keys line from the invite tag to the joiner's engineId). */
  burnAndGet(token: string): InviteRecord | undefined {
    const h = hashToken(token);
    const rec = this.records.find((r) => r.hash === h && !r.used);
    if (!rec) return undefined;
    rec.used = true;
    this.save();
    return rec;
  }

  /** §13a/f: remove expired, UNBURNED invite records (the "unpaired invite" expiry sweep) and
   *  return the ones that carried an ssh-layer keyTag so the caller can remove their
   *  authorized_keys lines too — no key material outlives its invite. */
  sweepExpired(): Array<{ id: string; keyTag?: string }> {
    const now = this.now();
    const expired = this.records.filter((r) => !r.used && r.exp <= now);
    if (expired.length === 0) return [];
    const expiredIds = new Set(expired.map((r) => r.id));
    this.records = this.records.filter((r) => !expiredIds.has(r.id));
    this.save();
    return expired.map((r) => ({ id: r.id, keyTag: r.keyTag }));
  }
}
