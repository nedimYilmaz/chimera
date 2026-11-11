import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type NetExecResult = { stdout: string; stderr: string; code: number; errno?: string };
export type NetExecFn = (cmd: string, args: string[]) => Promise<NetExecResult>;

export const realNetExec: NetExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      // Spawn errors use string codes; process exit statuses use numeric codes.
      const errno = e && typeof e.code === "string" ? e.code : undefined;
      const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code, errno });
    });
  });

// ---------------------------------------------------------------------------
// SSH federation keys (fed.sshkey.ensure + fed.accept)
// ---------------------------------------------------------------------------
// Rationale (documented design decision): the federation transport is
// `ssh -N -L <localsock>:<remotesock> host` (see daemon ssh-tunnel.ts) — a `-N` session that
// only opens a direct-streamlocal forward. The accepted peer key must therefore permit
// FORWARDING and NOTHING ELSE. The OpenSSH authorized_keys option set that expresses this is:
//
//     restrict,port-forwarding
//
//   * `restrict` enables ALL current+future restrictions (no pty, no agent/X11 forwarding, no
//     ~/.ssh/rc, no command execution) — the key becomes usable ONLY for what is re-enabled.
//   * `port-forwarding` re-enables forwarding (both TCP and unix/streamlocal); this is the one
//     capability the federation tunnel needs. OpenSSH has no finer authorized_keys toggle that
//     limits to streamlocal-only or to a single socket path (`permitopen` covers TCP only), so
//     `restrict,port-forwarding` is the tightest set that still allows the `-L …:remotesock`
//     forward while forbidding shell/exec — and `-N` on the client means no command runs anyway.
export const FED_AUTHORIZED_KEYS_OPTIONS = "restrict,port-forwarding";

export class FedKeyError extends Error { code = "protocol" as const; name = "FedKeyError"; }

// The SSH key type prefixes we accept for a peer's public key. ed25519 is what our own
// fed.sshkey.ensure generates; the others are accepted so an operator can bind an existing key.
const SSH_KEY_TYPES = ["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "sk-ssh-ed25519@openssh.com"];

// Validate an SSH public key LINE shape: "<type> <base64blob> [comment]". The base64 blob must
// decode and its first embedded length-prefixed string must equal the declared type — this
// catches a truncated/forged blob, not just a bad prefix. Returns the normalized "<type> <blob>"
// (comment stripped) so accept() controls the comment field. Throws FedKeyError on any mismatch.
export function validateSshPublicKey(line: string): { type: string; blob: string } {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) throw new FedKeyError("public key must be '<type> <base64>'");
  const [type, blob] = parts as [string, string];
  if (!SSH_KEY_TYPES.includes(type)) throw new FedKeyError(`unsupported key type "${type}"`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) throw new FedKeyError("key body is not base64");
  let decoded: Buffer;
  try { decoded = Buffer.from(blob, "base64"); } catch { throw new FedKeyError("key body is not base64"); }
  // The blob starts with a 4-byte big-endian length + that many bytes = the key type string.
  if (decoded.length < 4) throw new FedKeyError("key body too short");
  const n = decoded.readUInt32BE(0);
  if (n <= 0 || decoded.length < 4 + n) throw new FedKeyError("malformed key body");
  const embeddedType = decoded.subarray(4, 4 + n).toString("ascii");
  if (embeddedType !== type) throw new FedKeyError(`key type mismatch (declared "${type}", embedded "${embeddedType}")`);
  return { type, blob };
}

// fed.sshkey.ensure: ensure ${home}/fed_ssh_key (ed25519, 0600) exists and return its public key.
// Idempotent — an existing key is reused, never regenerated. Generation goes through the exec
// seam (ssh-keygen) so tests inject a fake that writes the key files without a real subprocess.
// (EngineIdentity's node-crypto ed25519 was considered for reuse but produces PKCS8/DER keys, not
// the OpenSSH `ssh-ed25519 AAAA…` format `ssh -i` + authorized_keys require — so ssh-keygen it is.)
export async function ensureFedSshKey(opts: { home: string; engineId: string; exec?: NetExecFn }): Promise<{ publicKey: string }> {
  const exec = opts.exec ?? realNetExec;
  const keyFile = join(opts.home, "fed_ssh_key");
  const pubFile = `${keyFile}.pub`;
  if (existsSync(keyFile) && existsSync(pubFile)) {
    return { publicKey: readFileSync(pubFile, "utf8").trim() };
  }
  mkdirSync(opts.home, { recursive: true });
  const res = await exec("ssh-keygen", ["-t", "ed25519", "-f", keyFile, "-N", "", "-C", `chimera-fed:${opts.engineId}`]);
  if (res.code !== 0 || !existsSync(pubFile)) {
    throw new FedKeyError(`ssh-keygen failed (exit ${res.code})`);   // never echo stdout — could contain paths only, but keep it clean
  }
  return { publicKey: readFileSync(pubFile, "utf8").trim() };
}

// The federation authorized_keys file. Kept INSIDE ${home} (never the user's live ~/.ssh) so the
// daemon owns it and tests stay hermetic; wiring sshd to read it (AuthorizedKeysFile / a Match
// block) is deployment configuration, out of scope for D6 (documented residual).
function authKeysPath(home: string): string { return join(home, "authorized_keys"); }

// §13c: the user's LIVE ~/.ssh/authorized_keys — the file sshd actually reads by default, with
// zero deployment configuration required. A deliberate, BOUNDED deviation from D6's ${home} file
// (forward-only lines, tagged with the same chimera-fed: comment, fully reversible). userSshDir
// is an injectable seam (default ~/.ssh) so no test ever touches a real user's ssh directory.
export type UserSshDirFn = () => string;
export const defaultUserSshDir: UserSshDirFn = () => join(homedir(), ".ssh");

const FED_COMMENT_PREFIX = "chimera-fed:";

function taggedAuthKeysPath(opts: { home: string; target?: "home" | "user"; userSshDir?: string }): string {
  if (opts.target === "user") return join(opts.userSshDir ?? defaultUserSshDir(), "authorized_keys");
  return authKeysPath(opts.home);
}

// Idempotent replace: drop any prior line whose comment is EXACTLY `chimera-fed:<tag>`, then
// (when `line` is provided) append the new one. Atomic tmp+rename, 0600 — shared by acceptFedKey,
// removeFedKey, and retagFedKey so the write discipline is identical in every mode.
function replaceTaggedLine(file: string, tag: string, line: string | null): void {
  const comment = `${FED_COMMENT_PREFIX}${tag}`;
  const existing = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const kept = existing.filter((l) => {
    const t = l.trim();
    if (t === "") return false;
    return !t.endsWith(` ${comment}`);
  });
  if (line !== null) kept.push(line);
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 });
  renameSync(tmp, file);
}

// fed.accept: bind a peer's public key with a RESTRICTED authorized_keys line. Validates the key
// shape first, then writes "restrict,port-forwarding <type> <blob> chimera-fed:<tag>".
// IDEMPOTENT: any prior line owned by this tag (matched by the chimera-fed:<tag> comment) is
// removed before the new one is appended — a re-accept REPLACES, never duplicates.
//
// `target` (§13c, ADDITIVE — default "home" is BYTE-IDENTICAL to D6): "user" writes into the
// user's live ~/.ssh/authorized_keys instead of ${home}/authorized_keys. This is the mode
// Cloudflare-federation bootstrap uses (§13a/b) because it needs the line sshd actually consults
// with zero deployment configuration; operators who prefer wiring sshd to the D6 ${home} file
// keep that option by simply never passing target:"user".
export function acceptFedKey(opts: {
  home: string; engineId: string; publicKey: string;
  target?: "home" | "user"; userSshDir?: string; tag?: string;
}): { engineId: string; line: string } {
  const { type, blob } = validateSshPublicKey(opts.publicKey);
  const tag = opts.tag ?? opts.engineId;
  const comment = `${FED_COMMENT_PREFIX}${tag}`;
  const line = `${FED_AUTHORIZED_KEYS_OPTIONS} ${type} ${blob} ${comment}`;
  const file = taggedAuthKeysPath(opts);
  replaceTaggedLine(file, tag, line);
  return { engineId: opts.engineId, line };
}

// §13a/f: remove a tagged line outright (invite revoke, expiry sweep, or join rollback). Returns
// whether a line was actually removed (idempotent — a second call on an absent tag is a no-op).
export function removeFedKey(opts: { home: string; tag: string; target?: "home" | "user"; userSshDir?: string }): boolean {
  const file = taggedAuthKeysPath(opts);
  if (!existsSync(file)) return false;
  const before = readFileSync(file, "utf8");
  replaceTaggedLine(file, opts.tag, null);
  const after = existsSync(file) ? readFileSync(file, "utf8") : "";
  return before !== after;
}

// §13a: on successful pairing, retag the inviter's authorized_keys line from
// `chimera-fed:invite-<inviteId>` to `chimera-fed:<joinerEngineId>` — the key no longer expires
// with the invite; it is now the durable link's key. No-op (returns false) if the old tag isn't
// found (already retagged, or the invite key mode wasn't used for this pairing).
export function retagFedKey(opts: {
  home: string; oldTag: string; newTag: string; target?: "home" | "user"; userSshDir?: string;
}): boolean {
  const file = taggedAuthKeysPath(opts);
  if (!existsSync(file)) return false;
  const oldComment = `${FED_COMMENT_PREFIX}${opts.oldTag}`;
  const lines = readFileSync(file, "utf8").split("\n");
  const idx = lines.findIndex((l) => l.trim() !== "" && l.trim().endsWith(` ${oldComment}`));
  if (idx < 0) return false;
  const newComment = `${FED_COMMENT_PREFIX}${opts.newTag}`;
  const oldLine = lines[idx]!.trim();
  const newLine = oldLine.slice(0, oldLine.length - oldComment.length) + newComment;
  lines[idx] = newLine;
  const kept = lines.filter((l) => l.trim() !== "");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 });
  renameSync(tmp, file);
  return true;
}

// ---------------------------------------------------------------------------
// §13a: per-invite ephemeral ed25519 keypair — minted so a not-yet-pinned joiner can already
// authenticate the FIRST SSH connection to the inviter. Generated via the SAME ssh-keygen exec
// seam as ensureFedSshKey (no real subprocess under test); the temp key FILES are deleted right
// after being read into memory — the private half is never left at rest on the inviter's disk,
// it rides only the shown-once blob (D0 invariant).
// ---------------------------------------------------------------------------
export async function mintInviteKeypair(opts: { exec?: NetExecFn; tmpDir?: string }): Promise<{ publicKey: string; privateKey: string }> {
  const exec = opts.exec ?? realNetExec;
  const dir = opts.tmpDir ?? tmpdir();
  const keyFile = join(dir, `chimera-fed-invite-${randomUUID()}`);
  const pubFile = `${keyFile}.pub`;
  const res = await exec("ssh-keygen", ["-t", "ed25519", "-f", keyFile, "-N", "", "-C", "chimera-fed:invite"]);
  if (res.code !== 0 || !existsSync(pubFile) || !existsSync(keyFile)) {
    throw new FedKeyError(`ssh-keygen failed to mint an invite keypair (exit ${res.code})`);
  }
  try {
    const publicKey = readFileSync(pubFile, "utf8").trim();
    const privateKey = readFileSync(keyFile, "utf8");
    return { publicKey, privateKey };
  } finally {
    try { unlinkSync(keyFile); } catch { /* best-effort cleanup */ }
    try { unlinkSync(pubFile); } catch { /* best-effort cleanup */ }
  }
}

// §13a: the joiner's side of the ephemeral keypair — write the shown-once private key to
// ~/.chimera/federation/<peerEngineId>.key (0600), the exact path §4's `IdentityFile` names.
export function writeIdentityKeyFile(opts: { home: string; peerEngineId: string; privateKey: string }): { path: string } {
  const dir = join(opts.home, "federation");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${opts.peerEngineId}.key`);
  writeFileSync(path, opts.privateKey.endsWith("\n") ? opts.privateKey : `${opts.privateKey}\n`, { mode: 0o600 });
  return { path };
}

// §13f rollback: remove a written identity key file. Idempotent (no-op if already absent).
export function removeIdentityKeyFile(opts: { home: string; peerEngineId: string }): void {
  const path = join(opts.home, "federation", `${opts.peerEngineId}.key`);
  try { unlinkSync(path); } catch { /* absent is fine */ }
}

// ---------------------------------------------------------------------------
// §13d: host-key provenance. Reading /etc/ssh/ssh_host_*.pub is behind an injectable seam —
// NEVER touched for real under test. World-readable, not a secret.
// ---------------------------------------------------------------------------
export type ReadHostKeysFn = () => string[];

export const realReadHostKeys: ReadHostKeysFn = () => {
  try {
    return readdirSync("/etc/ssh")
      .filter((f) => f.startsWith("ssh_host_") && f.endsWith(".pub"))
      .map((f) => readFileSync(join("/etc/ssh", f), "utf8").trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];   // no /etc/ssh (containers, non-standard sshd, or no read permission) — not fatal
  }
};

// §13d: materialize a peer's sshd host public key lines into the managed
// ~/.chimera/federation/known_hosts as "<hostname> <type> <blob>" entries. Idempotent — entries
// for `hostname` are replaced wholesale on each call (a rotated host key updates cleanly).
// StrictHostKeyChecking=yes then holds with zero interactive prompts and no ssh-keyscan.
export function materializeKnownHosts(opts: { home: string; hostname: string; hostKeyLines: string[] }): { path: string } {
  const dir = join(opts.home, "federation");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "known_hosts");
  const existing = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "") : [];
  const kept = existing.filter((l) => !l.startsWith(`${opts.hostname} `));
  const added = opts.hostKeyLines.map((l) => `${opts.hostname} ${l}`);
  const all = [...kept, ...added];
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, all.length ? all.join("\n") + "\n" : "", { mode: 0o600 });
  renameSync(tmp, path);
  return { path };
}

// §13f rollback: remove all known_hosts entries for one hostname. Idempotent.
export function removeKnownHostsEntries(opts: { home: string; hostname: string }): void {
  const path = join(opts.home, "federation", "known_hosts");
  if (!existsSync(path)) return;
  const kept = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "" && !l.startsWith(`${opts.hostname} `));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 });
  renameSync(tmp, path);
}
