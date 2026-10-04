import { execFile } from "node:child_process";
import type { AccountAuth, ProviderProfile } from "@chimera/protocol";
import type { OAuthTokenStore } from "./providers/oauth.js";

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;

const realExec: ExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout) =>
      resolve({ stdout: stdout ?? "", code: err ? 1 : 0 }));
  });

export class CredentialError extends Error {
  code = "credential" as const;
  name = "CredentialError";
}

// F23-0D: the oauth case's deps, optional and additive (a 3rd constructor arg) — every
// existing call site (`new CredentialResolver(exec)` / `new CredentialResolver(exec, env)`)
// stays byte-identical and the oauth case keeps throwing CredentialError exactly like
// F23-0A's stub did, until the daemon actually wires a real OAuthTokenStore + catalog.
export type OAuthResolverDeps = { store: OAuthTokenStore; findProvider: (id: string) => ProviderProfile | undefined };

export class CredentialResolver {
  constructor(
    private exec: ExecFn = realExec,
    private env: NodeJS.ProcessEnv = process.env,
    private oauth?: OAuthResolverDeps,
  ) {}

  async resolve(auth: AccountAuth): Promise<{ envVar: string; value: string } | null> {
    switch (auth.type) {
      case "subscription":
        return null;
      case "env": {
        const value = this.env[auth.var];
        // reject unset, empty, and whitespace-only — parity with keychain/command
        // and the binding "empty/whitespace value → throw" rule (value kept untrimmed for injection)
        if (!value || value.trim() === "") throw new CredentialError(`env var ${auth.var} is unset or empty`);
        return { envVar: auth.injectAs, value };
      }
      case "keychain": {
        const { stdout, code } = await this.exec("security", ["find-generic-password", "-s", auth.service, "-w"]);
        const value = stdout.trim();
        if (code !== 0 || !value) throw new CredentialError(`keychain lookup failed for service ${auth.service}`);
        return { envVar: auth.injectAs, value };
      }
      case "command": {
        const { stdout, code } = await this.exec("sh", ["-c", auth.run]);
        const value = stdout.trim();
        if (code !== 0 || !value) throw new CredentialError(`credential command failed`);
        return { envVar: auth.injectAs, value };
      }
      case "oauth": {
        // F23-0D: load → refresh-if-expiring(<5min) → {envVar per profile, value: accessToken}.
        // Absent deps (no daemon-level OAuthTokenStore wired) preserves F23-0A's original
        // stub behavior exactly — always throws.
        if (!this.oauth) throw new CredentialError("oauth account not yet connected");
        const profile = this.oauth.findProvider(auth.provider);
        if (!profile) throw new CredentialError(`unknown oauth provider "${auth.provider}"`);
        if (!profile.envVar) throw new CredentialError(`provider "${auth.provider}" has no envVar configured for oauth credential injection`);
        const token = await this.oauth.store.getValid(auth.tokenRef, auth.provider, profile);
        if (!token) throw new CredentialError(`oauth account not connected (no token stored for "${auth.tokenRef}")`);
        return { envVar: profile.envVar, value: token.accessToken };
      }
    }
  }
}

// Union-of-spans redaction: find every occurrence of every secret as a
// LITERAL substring (no regex — a secret's characters, including any regex
// metacharacters, are never interpreted as a pattern), merge overlapping or
// adjacent match spans into one, then replace each merged span once. A prior
// single-pass alternation-regex attempt matched only the leftmost secret at
// each position and skipped ahead by that match's length, so two secrets that
// partially overlap without either containing the other (e.g. "abcd"/"cdef"
// over "abcdef", sharing "cd") left the non-matched tail of the second secret
// ("ef") unredacted — a real fragment leak. Collecting ALL matched spans from
// every secret and merging overlapping/adjacent ones before replacing closes
// that gap: "abcdef" now has spans [0,4) from "abcd" and [2,6) from "cdef",
// which overlap and merge into [0,6), so the whole string collapses to a
// single "[REDACTED]" with no fragment of either secret surviving. redact()
// is the last line of defense before secrets reach log sinks (spec §6).
export function redact(text: string, secrets: string[]): string {
  const nonEmpty = secrets.filter((s) => s.length > 0);
  if (nonEmpty.length === 0) return text;

  const spans: Array<[start: number, end: number]> = [];
  for (const secret of nonEmpty) {
    let idx = text.indexOf(secret);
    while (idx !== -1) {
      spans.push([idx, idx + secret.length]);
      // advance by 1 (not secret.length) so self-overlapping occurrences of
      // the same secret are also found, not just non-overlapping ones
      idx = text.indexOf(secret, idx + 1);
    }
  }
  if (spans.length === 0) return text;

  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[start: number, end: number]> = [spans[0]];
  for (let i = 1; i < spans.length; i++) {
    const last = merged[merged.length - 1];
    const [start, end] = spans[i];
    if (start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  let result = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    result += text.slice(cursor, start) + "[REDACTED]";
    cursor = end;
  }
  result += text.slice(cursor);
  return result;
}
