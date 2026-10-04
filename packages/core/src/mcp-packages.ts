import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  McpPackageInspectParams, McpPackageInstallParams, McpManagedPackageSchema,
  type McpPackageReview, type McpStoreEntry,
} from "@chimera/protocol";
import type { McpStoreRegistry } from "./mcpstore.js";

const REGISTRY = "https://registry.npmjs.org";
const MAX_METADATA = 4 * 1024 * 1024;
type Manifest = {
  name: string; version: string; bin?: string | Record<string, string>;
  dist: { integrity: string; tarball: string }; license?: unknown;
  scripts?: Record<string, unknown>;
};
type Review = { public: McpPackageReview; manifest: Manifest; bins: Record<string, string> };
type Runner = (args: string[], cwd: string) => Promise<void>;

export class McpPackageError extends Error { code = "protocol" as const; }

// Managed servers never inherit provider credentials, NODE_OPTIONS or npm config.
// This limits accidental disclosure; running a package is NOT an OS sandbox.
export function managedProcessEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = new Set(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LOCALAPPDATA", "APPDATA"]);
  for (const [key, value] of Object.entries(source)) if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  return env;
}

function contained(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function registryTarball(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.origin === REGISTRY && !u.username && !u.password && !u.search && !u.hash && u.pathname.endsWith(".tgz");
  } catch { return false; }
}

function packageBins(manifest: Manifest): Record<string, string> {
  const bins = typeof manifest.bin === "string"
    ? { [manifest.name.split("/").at(-1)!]: manifest.bin } : manifest.bin;
  if (!bins || typeof bins !== "object" || Array.isArray(bins) || !Object.keys(bins).length || Object.keys(bins).length > 64) {
    throw new McpPackageError("Package must declare between 1 and 64 executables.");
  }
  for (const [name, path] of Object.entries(bins)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,213}$/.test(name) || typeof path !== "string"
      || path.length > 1024 || path.includes("\\") || path.includes(":") || path.includes("\0")
      || isAbsolute(path) || path.split("/").includes("..") || !path.replace(/^\.\//, "")) {
      throw new McpPackageError("Package declares an unsafe executable path.");
    }
  }
  return bins;
}

async function fetchManifest(packageName: string, version: string): Promise<unknown> {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`, {
    signal: AbortSignal.timeout(10_000), redirect: "error", headers: { Accept: "application/json" },
  });
  if (!response.ok || !response.body) throw new McpPackageError(`npm metadata request failed (${response.status}). Check the package name and exact version.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_METADATA) throw new McpPackageError("Package metadata exceeds the size limit.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Resolve npm's JS entrypoint, never `npm.cmd` through a shell. Also works when
// chimerad itself is a compiled Bun binary: process.execPath is not necessarily Node.
export function findManagedNpmRuntime(): { node: string; cli: string } {
  const search = [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter).filter(isAbsolute)];
  for (const dir of search) {
    const node = join(dir, process.platform === "win32" ? "node.exe" : "node");
    if (!existsSync(node)) continue;
    const candidates = [join(dir, "node_modules/npm/bin/npm-cli.js"), join(dir, "../lib/node_modules/npm/bin/npm-cli.js")];
    const npm = join(dir, "npm");
    if (existsSync(npm)) candidates.unshift(realpathSync(npm));
    for (const candidate of candidates) {
      if (candidate.endsWith(`${sep}npm-cli.js`) && existsSync(candidate) && lstatSync(realpathSync(candidate)).isFile()) {
        return { node: realpathSync(node), cli: realpathSync(candidate) };
      }
    }
  }
  throw new McpPackageError("Managed MCP packages need a Node.js installation with npm on PATH. No package was installed.");
}

function npmRunner(runtime: { node: string; cli: string }): Runner {
  return (args, cwd) => new Promise((ok, fail) => {
    execFile(runtime.node, [runtime.cli, ...args], {
      cwd, env: managedProcessEnv(), timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
      windowsHide: true, shell: false,
    }, (error) => {
      // npm output can contain paths, config and dependency-controlled text. Do not
      // echo it into UI/transcripts or attach the raw child-process error as a cause.
      if (error) fail(new McpPackageError("npm installation failed or timed out. Lifecycle scripts remain disabled; packages requiring them are unsupported."));
      else ok();
    });
  });
}

/** Operator-only package lifecycle. Agent MCP tools intentionally do not expose it. */
export class McpPackageInstaller {
  private reviews = new Map<string, Review>();
  private installing = false;
  readonly root: string;

  constructor(private registry: McpStoreRegistry, home: string, private seams: {
    manifest?: (name: string, version: string) => Promise<unknown>;
    runtime?: () => { node: string; cli: string };
    run?: Runner;
    now?: () => number;
  } = {}) { this.root = resolve(home, "mcp-packages"); }

  private now(): number { return this.seams.now?.() ?? Date.now(); }

  async inspect(input: unknown): Promise<McpPackageReview> {
    const p = McpPackageInspectParams.parse(input);
    let raw: unknown;
    try { raw = await (this.seams.manifest ?? fetchManifest)(p.packageName, p.version); }
    catch (e) { if (e instanceof McpPackageError) throw e; throw new McpPackageError("Could not read npm package metadata. Check your connection and try again."); }
    const m = raw as Manifest | undefined;
    if (!m || m.name !== p.packageName || m.version !== p.version || !registryTarball(m.dist?.tarball)
      || !McpManagedPackageSchema.shape.integrity.safeParse(m.dist?.integrity).success) {
      throw new McpPackageError("npm returned invalid package identity or integrity metadata.");
    }
    const bins = packageBins(m);
    const review: McpPackageReview = {
      reviewId: randomUUID(), packageName: m.name, version: m.version,
      integrity: m.dist.integrity, bins: Object.keys(bins).sort(),
      hasInstallScripts: ["preinstall", "install", "postinstall", "prepare"].some((key) => !!m.scripts?.[key]),
      ...(typeof m.license === "string" ? { license: m.license.slice(0, 256) } : {}),
      expiresAt: this.now() + 10 * 60_000,
    };
    for (const [id, old] of this.reviews) if (old.public.expiresAt <= this.now()) this.reviews.delete(id);
    if (this.reviews.size >= 64) this.reviews.delete(this.reviews.keys().next().value!);
    this.reviews.set(review.reviewId, { public: review, manifest: m, bins });
    return structuredClone(review);
  }

  private prepareRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink() || !lstatSync(this.root).isDirectory()) throw new McpPackageError("MCP package directory must be a real directory, not a link.");
  }

  async install(input: unknown): Promise<McpStoreEntry> {
    const p = McpPackageInstallParams.parse(input);
    const review = this.reviews.get(p.reviewId);
    if (!review || review.public.expiresAt <= this.now()) throw new McpPackageError("Package review expired. Inspect the package again before installing.");
    if (!Object.hasOwn(review.bins, p.bin)) throw new McpPackageError("Select an executable from the reviewed package.");
    if (this.installing) throw new McpPackageError("Another MCP package installation is in progress. Wait for it to finish.");
    if (this.registry.has(p.name)) throw new McpPackageError("An MCP server already uses that name. Choose another name.");
    const runtime = (this.seams.runtime ?? findManagedNpmRuntime)();
    const run = this.seams.run ?? npmRunner(runtime);
    this.prepareRoot();
    const id = randomUUID();
    const stage = mkdtempSync(join(this.root, ".install-"));
    const finalDir = join(this.root, id);
    this.installing = true;
    let moved = false;
    try {
      writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "chimera-managed-mcp", version: "1.0.0", private: true, dependencies: { [review.public.packageName]: review.public.version } }), { mode: 0o600, flag: "wx" });
      writeFileSync(join(stage, "empty.npmrc"), "", { mode: 0o600, flag: "wx" });
      // Never read a user's registry credentials/config and never run package scripts.
      // Each package gets its own lockfile/cache; Chimera's repository is untouched.
      const flags = ["--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier", "--registry", REGISTRY,
        "--userconfig", join(stage, "empty.npmrc"), "--globalconfig", join(stage, "empty-global.npmrc"),
        "--cache", join(stage, ".npm-cache"), "--git", join(stage, "git-disabled"), "--loglevel=error"];
      await run(["install", "--package-lock-only", ...flags], stage);
      this.validateLock(stage, review);
      await run(["ci", ...flags], stage);
      const pkgRoot = join(stage, "node_modules", ...review.public.packageName.split("/"));
      const realStage = realpathSync(stage);
      const realPackage = realpathSync(pkgRoot);
      if (!contained(realStage, realPackage)) throw new McpPackageError("Installed package escapes its installation directory.");
      const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as Manifest;
      if (manifest.name !== review.public.packageName || manifest.version !== review.public.version
        || packageBins(manifest)[p.bin] !== review.bins[p.bin]) throw new McpPackageError("Installed executable differs from the reviewed package.");
      const bin = realpathSync(join(pkgRoot, review.bins[p.bin]!));
      if (!contained(realPackage, bin) || !lstatSync(bin).isFile()) throw new McpPackageError("Installed executable escapes its package directory.");
      // Invoke JS directly with Node on every OS, never an npm-generated shell shim.
      if (!/\.(?:c|m)?js$/i.test(bin)) throw new McpPackageError("This installer currently supports JavaScript (.js/.cjs/.mjs) executables only.");
      writeFileSync(join(stage, "chimera-install.json"), JSON.stringify({ id, serverName: p.name, packageName: review.public.packageName, version: review.public.version }), { mode: 0o600, flag: "wx" });
      renameSync(stage, finalDir);
      moved = true;
      const installed = this.registry.add({
        name: p.name, type: "stdio", command: runtime.node,
        args: [join(finalDir, relative(realStage, bin)), ...p.args], env: {},
        enabled: false, trust: "untrusted", direct: false,
        managed: { id, ecosystem: "npm", packageName: review.public.packageName, version: review.public.version, integrity: review.public.integrity, bin: p.bin },
      });
      this.reviews.delete(p.reviewId);
      return installed;
    } catch (e) {
      // Recoverable quarantine, never recursive deletion of paths from a manifest.
      const abandoned = moved ? finalDir : stage;
      if (existsSync(abandoned)) {
        try { renameSync(abandoned, join(this.root, `.failed-${id}`)); } catch { /* left as an unregistered stage for manual recovery */ }
      }
      if (e instanceof McpPackageError) throw e;
      throw new McpPackageError("Package installation could not be committed. No server was enabled. Failed files are retained under mcp-packages for recovery.");
    } finally { this.installing = false; }
  }

  private validateLock(stage: string, review: Review): void {
    const lock = JSON.parse(readFileSync(join(stage, "package-lock.json"), "utf8"));
    if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") throw new McpPackageError("npm must produce a version 3 lockfile (npm 9 or later).");
    const root = lock.packages[`node_modules/${review.public.packageName}`];
    if (root?.version !== review.public.version || root?.integrity !== review.public.integrity || root?.resolved !== review.manifest.dist.tarball) {
      throw new McpPackageError("Package integrity changed since review. Inspect it again.");
    }
    for (const [path, raw] of Object.entries(lock.packages)) {
      if (path === "") continue;
      const entry = raw as { resolved?: unknown; integrity?: unknown; link?: unknown } | null;
      if (!path.startsWith("node_modules/") || path.includes("\\") || path.includes(":") || path.split("/").includes("..")
        || !entry || entry.link || !registryTarball(entry.resolved)
        || !McpManagedPackageSchema.shape.integrity.safeParse(entry.integrity).success) {
        throw new McpPackageError("Only integrity-pinned public npm dependencies are supported. Local, git, bundled or external URL dependencies were rejected.");
      }
    }
  }

  /** Called after disabling/closing the server. Return location for recovery, not deletion. */
  quarantine(entry: McpStoreEntry): void {
    if (entry.type !== "stdio" || !entry.managed) return;
    const meta = McpManagedPackageSchema.parse(entry.managed);
    this.prepareRoot();
    const directory = join(this.root, meta.id);
    if (!existsSync(directory)) return;
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new McpPackageError("Refusing to uninstall a linked package directory.");
    let owner: { id?: string; serverName?: string; packageName?: string; version?: string };
    try { owner = JSON.parse(readFileSync(join(directory, "chimera-install.json"), "utf8")); }
    catch { throw new McpPackageError("Package ownership record is missing. Files were left untouched for manual recovery."); }
    if (owner?.id !== meta.id || owner.serverName !== entry.name || owner.packageName !== meta.packageName || owner.version !== meta.version) {
      throw new McpPackageError("Package ownership does not match this server. Files were left untouched.");
    }
    renameSync(directory, join(this.root, `.removed-${meta.id}-${randomUUID()}`));
  }
}
