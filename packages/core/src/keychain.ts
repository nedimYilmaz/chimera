import { execFile } from "node:child_process";
import type { ExecFn } from "./credentials.js";

// D7 (config management & accounts): the ONE place an account API key ever lives.
// `accounts.setKey` writes it here (service "chimera:<account>"), the CredentialResolver
// reads it back at spawn time (keychain auth), and it NEVER appears in config files, RPC
// responses, event logs, or error messages (D0 invariant). Behind an injectable seam so
// tests exercise the CRUD with an in-memory fake and the real `security(1)` binary never
// runs under test.
export interface Keychain {
  /** The stored secret for `service`, or null when no item exists. */
  get(service: string): Promise<string | null>;
  /** Create or replace the secret for `service`. */
  set(service: string, value: string): Promise<void>;
  /** Remove the item for `service`; a missing item is not an error (idempotent). */
  delete(service: string): Promise<void>;
}

// The canonical keychain service name for an account's key.
export function accountService(name: string): string {
  return `chimera:${name}`;
}

// The canonical keychain service name for an mcpstore remote server's auth secret
// (mcpstore.setAuth, McpStoreHttpAuth.keychainRef). Namespaced under "mcp:" so it can
// never collide with an account's `chimera:<name>` service even given the same `name`.
export function mcpStoreAuthService(name: string): string {
  return `chimera:mcp:${name}`;
}

// Real macOS Keychain via the `security` CLI. Same ExecFn seam shape as the rest of the
// repo (credentials.ts / hosttools.ts) — never invoked in tests (they inject
// InMemoryKeychain). NOTE (documented residual): `security add-generic-password -w <value>`
// passes the secret in argv, briefly visible to `ps`; the macOS CLI offers no stdin path
// for the value. Acceptable for the local single-user daemon; revisit if it ever matters.
export class MacKeychain implements Keychain {
  private exec: ExecFn;
  constructor(private label = "chimera", exec?: ExecFn) {
    this.exec = exec ?? ((cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) =>
          resolve({ stdout: `${stdout ?? ""}${stderr ?? ""}`, code: err ? ((err as { code?: number }).code ?? 1) : 0 }));
      }));
  }

  async get(service: string): Promise<string | null> {
    const { stdout, code } = await this.exec("security", ["find-generic-password", "-s", service, "-a", this.label, "-w"]);
    if (code !== 0) return null;
    const v = stdout.replace(/\n$/, "");
    return v === "" ? null : v;
  }

  async set(service: string, value: string): Promise<void> {
    // -U updates in place when the item already exists (else add fails on a duplicate).
    const { code, stdout } = await this.exec("security",
      ["add-generic-password", "-U", "-s", service, "-a", this.label, "-w", value]);
    // NEVER echo `value` (or stdout, which could contain it) in the thrown message — D0.
    if (code !== 0) throw new KeychainError(`keychain write failed for ${service} (exit ${code})`);
    void stdout;
  }

  async delete(service: string): Promise<void> {
    // A missing item exits non-zero; treat delete as idempotent (no throw).
    await this.exec("security", ["delete-generic-password", "-s", service, "-a", this.label]);
  }
}

export class KeychainError extends Error {
  code = "keychain" as const;
  name = "KeychainError";
}

// In-memory fake for tests: same contract, no `security` process. Token-free (D0).
export class InMemoryKeychain implements Keychain {
  private store = new Map<string, string>();
  constructor(seed?: Record<string, string>) {
    if (seed) for (const [k, v] of Object.entries(seed)) this.store.set(k, v);
  }
  async get(service: string): Promise<string | null> { return this.store.get(service) ?? null; }
  async set(service: string, value: string): Promise<void> { this.store.set(service, value); }
  async delete(service: string): Promise<void> { this.store.delete(service); }
  // test-only introspection (never used by production code)
  has(service: string): boolean { return this.store.has(service); }
}
