import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Keychain } from "./keychain.js";

// SECRET-MANAGER: operator-held secrets (API keys, tokens, notes) in the macOS Keychain, readable
// by SPECIFICALLY GRANTED agents and no one else.
//
// The split that matters: a VALUE lives only in the keychain, and this file's JSON holds only
// metadata and grants. Nothing here ever serialises a secret — not to secrets.json, not into an
// RPC response, not into an error message. That is the same D0 invariant accounts.ts already
// holds for account keys, applied to a store whose whole point is handing values out.
//
// Default is DENY. A secret with no grant is unreadable by every agent, and an agent asking for
// one gets the same answer whether it exists or not — a refusal that distinguishes "no access"
// from "no such secret" is an existence oracle over the operator's own key names.

export class UnknownSecretError extends Error { code = "protocol" as const; name = "UnknownSecretError"; }
export class SecretDeniedError extends Error { code = "denied" as const; name = "SecretDeniedError"; }
export class DuplicateSecretError extends Error { code = "conflict" as const; name = "DuplicateSecretError"; }

/** How a granted agent receives the value.
 *  - "inject": placed in the agent's PROCESS environment; the model never sees it. The agent uses
 *    it by naming the variable in a command, so the plaintext never enters its context and cannot
 *    be echoed, memorised or forwarded by the model — it is not in the model.
 *  - "reveal": returned by secret_get. Necessary when the agent must READ the value to decide
 *    something, and the point at which the allowlist has done all it can: from then on the agent
 *    holds the plaintext and can put it anywhere. */
export type SecretGrantMode = "inject" | "reveal";

export type SecretGrant = {
  agentId: string;
  mode: SecretGrantMode;
  grantedAt: number;
  /** The agent's display name AT GRANT TIME — for showing "who has access" without resolving a
   * possibly-dead agent, never for matching (an agent can be renamed; the id cannot). */
  agentLabel?: string;
};

export type SecretRecord = {
  name: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  grants: SecretGrant[];
};

/** What a LIST returns. Deliberately not `SecretRecord` — same shape today, a distinct name so a
 * future field on the record cannot silently start being served to a caller. */
export type SecretSummary = Omit<SecretRecord, "grants"> & { grants: SecretGrant[] };

export const SECRET_SERVICE_PREFIX = "chimera:secret:";
export function secretService(name: string): string { return `${SECRET_SERVICE_PREFIX}${name}`; }

// Letters/digits/_/- and a single "/" segment separator, so an operator can namespace
// ("aws/prod-key") without the name ever being able to escape its keychain service string.
const NAME_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

/** The env var an "inject" grant lands in: CHIMERA_SECRET_<NAME>, uppercased with every
 * non-alphanumeric run collapsed to "_" so "aws/prod-key" is reachable as
 * $CHIMERA_SECRET_AWS_PROD_KEY. */
export function secretEnvVar(name: string): string {
  return `CHIMERA_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export type SecretStoreDeps = {
  home: string;
  keychain: Keychain;
  /** Whether an agent is still live. A grant is bound to an agent and must never outlive it: the
   * id is reused by nothing, but a terminal agent's grant is dead weight that reads as access
   * still being held. Injected rather than importing the supervisor — this store must stay
   * testable without one. */
  isLiveAgent?: (agentId: string) => boolean;
  now?: () => number;
};

export class SecretStore {
  private records = new Map<string, SecretRecord>();
  private file: string;

  constructor(private deps: SecretStoreDeps) {
    mkdirSync(deps.home, { recursive: true });
    this.file = join(deps.home, "secrets.json");
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as { secrets: SecretRecord[] };
        for (const r of raw.secrets ?? []) this.records.set(r.name, r);
      } catch (err) {
        // Fail fast and name the file: unlike memory.json (operational state, tolerantly
        // quarantined), a torn secrets.json means the GRANT TABLE is unknown — and booting with
        // an empty one would silently revoke every grant while the keychain still holds every
        // value. Refusing to start is the safe direction.
        throw new Error(`corrupt secret grants in ${this.file}: ${(err as Error).message} — fix or remove the file and restart chimerad`);
      }
    }
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ secrets: [...this.records.values()] }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Grants whose agent is gone. Computed on read rather than swept on a timer: an agent going
   * terminal is not an event this store subscribes to, and a lazily-pruned grant is
   * indistinguishable from an eagerly-pruned one to every caller. */
  private live(grants: SecretGrant[]): SecretGrant[] {
    const isLive = this.deps.isLiveAgent;
    return isLive ? grants.filter((g) => isLive(g.agentId)) : grants;
  }

  // ---------- operator surface ----------

  async set(name: string, value: string, description?: string | null): Promise<SecretSummary> {
    if (!NAME_RE.test(name)) throw new DuplicateSecretError(`invalid secret name "${name}" — letters, digits, _ - and / only`);
    if (value.length === 0) throw new DuplicateSecretError("a secret's value cannot be empty");
    await this.deps.keychain.set(secretService(name), value);
    const existing = this.records.get(name);
    const record: SecretRecord = existing
      ? { ...existing, updatedAt: this.now(), ...(description !== undefined ? { description } : {}) }
      : { name, description: description ?? null, createdAt: this.now(), updatedAt: this.now(), grants: [] };
    this.records.set(name, record);
    this.save();
    return this.summarize(record);
  }

  list(): SecretSummary[] {
    return [...this.records.values()].map((r) => this.summarize(r));
  }

  async delete(name: string): Promise<boolean> {
    if (!this.records.has(name)) return false;
    this.records.delete(name);
    this.save();
    await this.deps.keychain.delete(secretService(name));   // value last: a half-delete leaves no readable orphan
    return true;
  }

  grant(name: string, agentId: string, mode: SecretGrantMode, agentLabel?: string): SecretSummary {
    const record = this.require(name);
    const grants = this.live(record.grants).filter((g) => g.agentId !== agentId);
    record.grants = [...grants, { agentId, mode, grantedAt: this.now(), ...(agentLabel ? { agentLabel } : {}) }];
    record.updatedAt = this.now();
    this.save();
    return this.summarize(record);
  }

  revoke(name: string, agentId: string): SecretSummary {
    const record = this.require(name);
    record.grants = this.live(record.grants).filter((g) => g.agentId !== agentId);
    record.updatedAt = this.now();
    this.save();
    return this.summarize(record);
  }

  // ---------- agent surface ----------

  /** The grant this agent holds for `name`, or null. Live-agent filtered, so a grant never
   * outlives the agent it was given to. */
  grantFor(name: string, agentId: string): SecretGrant | null {
    const record = this.records.get(name);
    if (!record) return null;
    return this.live(record.grants).find((g) => g.agentId === agentId) ?? null;
  }

  /** Names this agent may see — ONLY the ones it is granted. An agent must not learn what secrets
   * exist that it cannot have: that list is itself sensitive (it names the operator's accounts,
   * vendors and environments). */
  listFor(agentId: string): Array<{ name: string; description: string | null; mode: SecretGrantMode }> {
    const out: Array<{ name: string; description: string | null; mode: SecretGrantMode }> = [];
    for (const r of this.records.values()) {
      const g = this.live(r.grants).find((x) => x.agentId === agentId);
      if (g) out.push({ name: r.name, description: r.description, mode: g.mode });
    }
    return out;
  }

  /** Read a value on an agent's behalf. Refuses identically for "no such secret" and "not granted"
   * — a distinguishable refusal is an existence oracle over the operator's key names. */
  async read(name: string, agentId: string): Promise<string> {
    const grant = this.grantFor(name, agentId);
    if (!grant || grant.mode !== "reveal") {
      // Uniform BY CONSTRUCTION: the message is built from the requested name alone and says
      // nothing that differs between the three cases. It also stops short of naming an env var —
      // for a secret that does not exist there is no variable, and advice implying otherwise
      // sends the agent to chase a name nothing will ever set.
      throw new SecretDeniedError(
        `no readable secret "${name}" for this agent — it is not granted, is granted for injection only (in which case use its CHIMERA_SECRET_* variable in a command rather than reading it), or does not exist`,
      );
    }
    const value = await this.deps.keychain.get(secretService(name));
    if (value === null) throw new SecretDeniedError(`no readable secret "${name}" for this agent`);
    return value;
  }

  /** Every "inject"-granted value for an agent, as env vars. Called at process launch. */
  async injectedEnvFor(agentId: string): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const r of this.records.values()) {
      const g = this.live(r.grants).find((x) => x.agentId === agentId);
      if (!g || g.mode !== "inject") continue;
      const value = await this.deps.keychain.get(secretService(r.name));
      if (value !== null) env[secretEnvVar(r.name)] = value;
    }
    return env;
  }

  private require(name: string): SecretRecord {
    const r = this.records.get(name);
    if (!r) throw new UnknownSecretError(`unknown secret "${name}"`);
    return r;
  }

  /** NEVER carries a value — the one method every read path goes through, so there is a single
   * place to be sure of that. */
  private summarize(r: SecretRecord): SecretSummary {
    return { name: r.name, description: r.description, createdAt: r.createdAt, updatedAt: r.updatedAt, grants: this.live(r.grants) };
  }
}
