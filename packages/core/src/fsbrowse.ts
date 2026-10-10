import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FsEntry, FsEntryKind, FsGitStatus, FsListResult, FsReadResult } from "@chimera/protocol";
import { isPathUnder, ProjectPathError } from "./projects.js";
import { ARTIFACT_MAX_BYTES } from "./artifacts.js";

// FILEBROWSER-T2/T3: fs.list/fs.read's engine, split out of engine.ts so the
// realpath-escape guard, the entry cap, and the git-annotation pass each stay unit
// testable without spinning up a full Engine.

export const FS_LIST_MAX_ENTRIES = 1000;

// FILEBROWSER-T3: render cap for text content (mirrors read_artifact's UI-facing
// truncation, not a security bound) — files up to this size render in full, larger
// ones get their head with truncated:true. The hard refusal above this is
// ARTIFACT_MAX_BYTES (artifacts.ts), reused here rather than redefined so the two
// "how big is too big for the daemon to shuttle around" limits never drift apart.
export const FS_READ_MAX_BYTES = 2 * 1024 * 1024;

// Binary/image sniffing only inspects the head of the file — enough to catch a magic
// number or a null byte in any real binary format without reading megabytes just to
// classify it.
const SNIFF_BYTES = 8 * 1024;

export class FileTooLargeError extends Error { code = "protocol" as const; name = "FileTooLargeError"; }

// The WebView streams these directly through the native file scope; never shuttle
// an entire movie through JSON-RPC. A codec the OS cannot decode gets an open-in-app fallback.
const STREAM_MEDIA: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".ogv": "video/ogg", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet", ".odp": "application/vnd.oasis.opendocument.presentation",
};

const IMAGE_SIGNATURES: Array<{ mediaType: string; magic: number[] }> = [
  { mediaType: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { mediaType: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] }, // "GIF8", covers GIF87a/GIF89a
];

function detectImageMediaType(head: Buffer): string | null {
  for (const sig of IMAGE_SIGNATURES) {
    if (head.length >= sig.magic.length && sig.magic.every((b, i) => head[i] === b)) return sig.mediaType;
  }
  // WEBP is a RIFF container — "RIFF" + 4-byte size + "WEBP", the size field itself isn't checked.
  if (head.length >= 12 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// realpathSync throws a raw ENOENT (also for a broken symlink) — normalize to the same
// {code:"protocol"} shape every other fs-browser refusal uses, never a raw node error
// leaking through the RPC boundary.
function realpathOrThrow(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new ProjectPathError(`no such file or directory: "${path}"`);
  }
}

// Resolves `relPath` against the project's `root`, then re-checks with realpath on
// BOTH sides — root and target — before returning. realpath-ing only one side leaves a
// symlink-escape hole (the same recipe engine.ts's isRepoBusy uses, see its comment):
// a project could contain a symlink whose realpath resolves outside `root` entirely,
// and checking the raw resolved path against a non-realpath'd root would miss that.
export function resolveWithinProject(projectRoot: string, relPath: string): { root: string; target: string } {
  const root = realpathOrThrow(projectRoot);
  const target = realpathOrThrow(resolve(projectRoot, relPath));
  if (!isPathUnder(target, root)) throw new ProjectPathError(`path escapes project root: "${relPath}"`);
  return { root, target };
}

function classify(dirent: { isDirectory(): boolean; isSymbolicLink(): boolean }): FsEntryKind {
  if (dirent.isSymbolicLink()) return "symlink";
  if (dirent.isDirectory()) return "dir";
  return "file";
}

// One `git status --porcelain --ignored` per fs.list call, keyed by path relative to
// the git TOPLEVEL (porcelain's own path convention, always forward-slashed) so
// entries can be looked up with a plain relative() from that toplevel. Returns null
// for a non-git project (or if git itself is unavailable) — fs.list must degrade to
// all-null gitStatus in that case, never throw.
function gitStatusInfo(root: string): { toplevel: string; map: Map<string, FsGitStatus> } | null {
  let toplevel: string;
  try {
    toplevel = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
  let out: string;
  try {
    out = execFileSync("git", ["-C", toplevel, "status", "--porcelain", "--ignored"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return null;
  }
  const map = new Map<string, FsGitStatus>();
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const index = line[0];
    const worktree = line[1];
    const rest = line.slice(3);
    // A rename ("R  old -> new") only needs the new-side path for lookup purposes.
    const path = rest.includes(" -> ") ? rest.split(" -> ")[1]! : rest;
    let status: FsGitStatus;
    if (index === "?" && worktree === "?") status = "untracked";
    else if (index === "!" && worktree === "!") status = "ignored";
    else if (index !== " " && index !== "?") status = "staged";
    else status = "modified";
    map.set(path.replace(/\/$/, ""), status);
  }
  return { toplevel, map };
}

function gitRelKey(toplevel: string, absPath: string): string {
  return relative(toplevel, absPath).split(sep).join("/");
}

export function listDir(projectRoot: string, relPath: string): FsListResult {
  const { root, target } = resolveWithinProject(projectRoot, relPath);
  let dirents;
  try {
    dirents = readdirSync(target, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOTDIR") throw new ProjectPathError(`not a directory: "${relPath}"`);
    throw new ProjectPathError(`no such file or directory: "${relPath}"`);
  }
  const truncated = dirents.length > FS_LIST_MAX_ENTRIES;
  const capped = truncated ? dirents.slice(0, FS_LIST_MAX_ENTRIES) : dirents;
  const statusInfo = gitStatusInfo(root);
  const entries: FsEntry[] = capped.map((dirent) => {
    const kind = classify(dirent);
    const entryPath = resolve(target, dirent.name);
    let sizeBytes: number | null = null;
    if (kind !== "dir") {
      try { sizeBytes = statSync(entryPath).size; } catch { sizeBytes = null; }
    }
    const gitStatus = statusInfo ? (statusInfo.map.get(gitRelKey(statusInfo.toplevel, entryPath)) ?? null) : null;
    return { name: dirent.name, kind, sizeBytes, gitStatus };
  });
  return { path: relPath, entries, truncated };
}

export function readFile(projectRoot: string, relPath: string): FsReadResult {
  const { target } = resolveWithinProject(projectRoot, relPath);
  let stat;
  try {
    stat = statSync(target);
  } catch {
    throw new ProjectPathError(`no such file or directory: "${relPath}"`);
  }
  if (!stat.isFile()) throw new ProjectPathError(`not a file: "${relPath}"`);
  const streamType = STREAM_MEDIA[extname(target).toLowerCase()];
  if (streamType) {
    return { path: relPath, absolutePath: target, encoding: "utf8", content: "", sizeBytes: stat.size, binary: true, mediaType: streamType, truncated: false };
  }
  if (stat.size > ARTIFACT_MAX_BYTES) {
    throw new FileTooLargeError(`"${relPath}" is ${stat.size} bytes, over the ${ARTIFACT_MAX_BYTES}-byte cap — refused`);
  }

  const buf = readFileSync(target);
  const head = buf.subarray(0, SNIFF_BYTES);
  const mediaType = detectImageMediaType(head);
  if (mediaType) {
    return { path: relPath, absolutePath: target, encoding: "base64", content: buf.toString("base64"), sizeBytes: stat.size, binary: true, mediaType, truncated: false };
  }
  if (head.includes(0)) {
    // Non-image binary: the UI shows a placeholder, no point shipping the bytes.
    return { path: relPath, absolutePath: target, encoding: "utf8", content: "", sizeBytes: stat.size, binary: true, mediaType: null, truncated: false };
  }

  const truncated = buf.length > FS_READ_MAX_BYTES;
  const text = (truncated ? buf.subarray(0, FS_READ_MAX_BYTES) : buf).toString("utf8"); // lossy, mirrors read_artifact's from_utf8_lossy
  return { path: relPath, absolutePath: target, encoding: "utf8", content: text, sizeBytes: stat.size, binary: false, mediaType: null, truncated };
}

// PATH-LINK-TILDE-AND-SCOPE — expands a "~"-prefixed path against the REAL OS
// home dir (node:os's homedir(), injectable for tests), never $CHIMERA_HOME
// (a completely different directory — see engine.ts's own `home` field). Only
// the plain "~" and "~/..." forms are supported; "~user/..." (some OTHER
// user's home) is deliberately refused (returns null) rather than guessed at
// — there is no safe, portable way to resolve it from Node without shelling
// out, and the shape is rare enough in a transcript that refusing it (falls
// back to inert plain-text rendering, same as any other unresolved path) is
// an acceptable, safe answer. A path that isn't "~"-prefixed at all is
// returned unchanged (the caller already knows it's absolute).
export function expandHome(path: string, home: string = homedir()): string | null {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (path.startsWith("~")) return null;
  return path;
}

// PATH-LINK-TILDE-AND-SCOPE — the "no registered project" counterpart to
// readFile: resolves an absolute (or "~"-prefixed) path against a WIDENED set
// of roots (every registered project's root, plus config.projectImportDir —
// see engine.ts's fs.read case) instead of one project's tree. Deliberately
// reuses readFile/resolveWithinProject UNCHANGED for the actual containment
// check per candidate root: `resolve(root, absPath)` short-circuits to
// `absPath` itself when it's already absolute (Node's own path.resolve
// semantics), so resolveWithinProject's realpath-both-sides guard — the same
// one that blocks a project-escaping symlink — applies exactly as-is here,
// just tried against each candidate root in turn (first containing root
// wins) rather than a single known one. Never widens to "anything under the
// home directory": a target outside EVERY given root (e.g. ~/.ssh/id_rsa,
// with roots = [some project, some projectImportDir]) still throws, same as
// readFile always has.
export function readAtWidenedRoot(rawPath: string, roots: readonly string[], home: string = homedir()): FsReadResult {
  const absPath = expandHome(rawPath, home);
  if (absPath == null || !isAbsolute(absPath)) {
    throw new ProjectPathError(`unsupported path: "${rawPath}"`);
  }
  for (const root of roots) {
    try {
      return readFile(root, absPath);
    } catch {
      continue;
    }
  }
  throw new ProjectPathError(`path is outside every allowed root: "${rawPath}"`);
}
