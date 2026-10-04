// F23-2A: in-memory bookkeeping for an in-flight accounts.oauth_start/oauth_finish exchange.
// Device-code (and other server-polled) flows resolve asynchronously in the background —
// the RPC caller polls oauth_finish until the state moves off "pending". Never persisted
// (a daemon restart mid-flow just means the operator retries oauth_start); never logged raw
// (the resolved token itself is the last thing that should ever hit a log line).
import { randomUUID } from "node:crypto";
import type { OAuthTokenJson } from "./oauth.js";

export type PendingOAuthState =
  | { status: "pending" }
  | { status: "ready"; token: OAuthTokenJson }
  | { status: "error"; message: string };

export type PendingOAuthRecord = {
  provider: string;
  state: PendingOAuthState;
  expiresAt: number;   // epoch ms; a poll after this is treated as "unknown id" (swept lazily)
};

const DEFAULT_TTL_MS = 10 * 60_000;   // 10 minutes — generous for a device-code user to type the code in

export class PendingOAuthStore {
  private pending = new Map<string, PendingOAuthRecord>();

  constructor(
    private now: () => number = Date.now,
    private makeId: () => string = randomUUID,
  ) {}

  create(provider: string, ttlMs: number = DEFAULT_TTL_MS): { id: string; record: PendingOAuthRecord } {
    const id = this.makeId();
    const record: PendingOAuthRecord = { provider, state: { status: "pending" }, expiresAt: this.now() + ttlMs };
    this.pending.set(id, record);
    return { id, record };
  }

  // Lazily sweeps an expired entry to "unknown" rather than returning stale pending state.
  get(id: string): PendingOAuthRecord | undefined {
    const record = this.pending.get(id);
    if (!record) return undefined;
    if (record.expiresAt < this.now()) {
      this.pending.delete(id);
      return undefined;
    }
    return record;
  }

  resolve(id: string, token: OAuthTokenJson): void {
    const record = this.pending.get(id);
    if (record) record.state = { status: "ready", token };
  }

  fail(id: string, message: string): void {
    const record = this.pending.get(id);
    if (record) record.state = { status: "error", message };
  }

  delete(id: string): void {
    this.pending.delete(id);
  }
}
