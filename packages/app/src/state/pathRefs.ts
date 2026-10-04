// FILE-PATH-LINKS — resolves a `path`-kind InlineSpan (ui-state's tokenizer;
// SHAPE only, no fs access there) against the app's known project roots, then
// reads it through the daemon's existing fs.read RPC. No new Tauri command:
// fs.read (packages/core/src/fsbrowse.ts) already IS the confined, tested
// reader we need — it resolves `{project, path}` against the project's
// absolute root, realpath-checks BOTH sides (so a symlink escape can't slip
// through either), caps read size, and sniffs binary/image content. That
// confinement is enforced DAEMON-side (a trusted process authoritative over
// the project registry), not here — this module's OWN containment check
// (isPathUnderRoot/candidateRoots below) is a CLIENT-side pre-filter so an
// obviously-escaping path never even reaches an RPC call and never renders as
// clickable, not the security boundary itself. The daemon never trusts this
// layer either way (see fsbrowse.test.ts's own escape-path coverage).
//
// Two path shapes reach here (ui-state's PATH_TOKEN_SOURCE):
//  - absolute ("/Users/.../foo.ts"): must fall under exactly one registered
//    project's root (the MOST SPECIFIC root wins if projects nest) — anything
//    else is refused before ever calling fs.read.
//  - repo-relative ("packages/core/foo.ts"): ambiguous which project it's
//    relative to, so every registered project is tried in turn (bounded by
//    however many are registered) until one's fs.read succeeds.
import { useSyncExternalStore } from "react";
import type { FsReadResult } from "@chimera/protocol";
import type { RequestFn } from "./commands.coord";
import type { FsSelectedFile } from "./commands.projects";

export type ProjectRoot = { name: string; path: string };

// A pure POSIX ".."/"." normalizer — deliberately NOT node:path (this module
// runs in the webview, which has no node polyfill). This is what makes the
// containment check resolve-THEN-check instead of a naive string-prefix test:
// without it, "<root>/../../../../etc/passwd" would incorrectly read as
// "starts with <root>" even though it resolves somewhere else entirely. An
// absolute path's leading ".." segments are absorbed (POSIX: "/.." === "/",
// you can't go above root) rather than kept, matching node's path.resolve.
export function normalizePosixPath(raw: string): string {
  const absolute = raw.startsWith("/");
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return (absolute ? "/" : "") + out.join("/");
}

const stripTrailingSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** Path-prefix WITH boundary check, on NORMALIZED paths — mirrors core's
 * projects.ts isPathUnder (same "/a/b must not contain /a/bc" boundary rule),
 * reimplemented here rather than imported since @chimera/core is a node-only
 * package the webview bundle can't pull in. */
export function isPathUnderRoot(child: string, parent: string): boolean {
  const c = stripTrailingSlash(normalizePosixPath(child));
  const p = stripTrailingSlash(normalizePosixPath(parent));
  return c === p || c.startsWith(p === "" ? "/" : `${p}/`);
}

export function relPathUnder(root: string, absPath: string): string {
  const r = stripTrailingSlash(normalizePosixPath(root));
  const a = normalizePosixPath(absPath);
  if (a === r) return "";
  return a.slice(r.length + 1);
}

// PATH-LINK-TILDE-AND-SCOPE: "~/foo" is absolute-SHAPED (home-relative, not
// repo-relative) but isn't literally "/"-prefixed, so it needs its own check
// everywhere candidateRoots' `rawPath.startsWith("/")` branch does.
function isTildePath(rawPath: string): boolean {
  return rawPath === "~" || rawPath.startsWith("~/");
}

/** Candidate {project, relPath} pairs to try fs.read against, most-plausible
 * first. Empty for an absolute path that escapes every registered root, OR
 * for a "~"-path (never repo-relative-guessable, and this module doesn't
 * know the real home dir to pre-filter it — see resolvePathRef's separate
 * widened-root fallback) — the caller must treat an empty result as
 * "no registered-project candidate", not necessarily unresolved outright. */
export function candidateRoots(rawPath: string, projects: ProjectRoot[]): Array<{ project: string; relPath: string }> {
  if (isTildePath(rawPath)) return [];
  if (rawPath.startsWith("/")) {
    return [...projects]
      .filter((p) => isPathUnderRoot(rawPath, p.path))
      // longest (most specific) root first, so a nested project wins over an
      // ancestor one.
      .sort((a, b) => b.path.length - a.path.length)
      .map((p) => ({ project: p.name, relPath: relPathUnder(p.path, rawPath) }));
  }
  return projects.map((p) => ({ project: p.name, relPath: rawPath }));
}

export type PathResolution =
  | { status: "resolved"; project: string; relPath: string; result: FsReadResult }
  | { status: "unresolved" };

// PATH-LINK-TILDE-AND-SCOPE: the label shown (PathLink's title, "<label>:
// <path>") when a path resolves via the WIDENED root set (readAbsolute)
// rather than a named registered project — there is no single project name
// to report since the server tried several roots (see fsbrowse.ts's
// readAtWidenedRoot), so this is a fixed, recognizable stand-in instead.
export const WIDENED_ROOT_LABEL = "~";

/** Resolves one raw path string end-to-end: candidate roots, then fs.read
 * each in turn until one succeeds. Never throws — any failure (no candidate
 * root, every fs.read refused/erroring) settles to {status:"unresolved"}, the
 * caller's "render as plain text" case. `fetchProjects`/`readFile` are
 * injected (not imported from ../rpc/bridge) so this is unit-testable without
 * a Tauri runtime — mirrors commands.coord.ts's RequestFn injection.
 *
 * PATH-LINK-TILDE-AND-SCOPE: `readAbsolute` is a NEW, OPTIONAL fourth param
 * (existing callers omitting it keep the exact prior behavior — see
 * pathRefs.test.ts's pre-existing cases). When given, it's tried as a LAST
 * resort for an absolute- or "~"-shaped rawPath that no registered project
 * claimed: the server (fsbrowse.ts's readAtWidenedRoot) resolves it against
 * the widened root set (every registered project, plus
 * config.projectImportDir) — never against the whole home directory. This
 * module has no way to pre-filter a "~" path itself (it doesn't know the
 * real OS home dir — see candidateRoots), so unlike the registered-project
 * candidates above, this single attempt is the ONLY check performed
 * client-side; the server's realpath-both-sides containment check is what
 * actually refuses an escaping target (e.g. ~/.ssh/id_rsa) — this call is
 * therefore expected to fail (and fall through to "unresolved") for anything
 * outside the widened roots, exactly like any other refused candidate above. */
export async function resolvePathRef(
  rawPath: string,
  fetchProjects: () => Promise<ProjectRoot[]>,
  readFile: (project: string, relPath: string) => Promise<FsReadResult>,
  readAbsolute?: (rawPath: string) => Promise<FsReadResult>,
): Promise<PathResolution> {
  let projects: ProjectRoot[];
  try {
    projects = await fetchProjects();
  } catch {
    return { status: "unresolved" };
  }
  for (const c of candidateRoots(rawPath, projects)) {
    try {
      const result = await readFile(c.project, c.relPath);
      return { status: "resolved", project: c.project, relPath: c.relPath, result };
    } catch {
      continue;
    }
  }
  if (readAbsolute && (isTildePath(rawPath) || rawPath.startsWith("/"))) {
    try {
      const result = await readAbsolute(rawPath);
      return { status: "resolved", project: WIDENED_ROOT_LABEL, relPath: result.path, result };
    } catch {
      // falls through to unresolved, same as any other refused candidate
    }
  }
  return { status: "unresolved" };
}

// ---------------------------------------------------------------------------
// session-lifetime caches — module singletons (same pattern as
// ArtifactPreviewCard's direct rpcCall use): a project's root list rarely
// changes mid-session, and a given raw path string resolves to the same
// answer every time it's rendered, so both are memoized to bound RPC/read
// traffic. Resolution is LAZY (per rendered span, on mount — see PathLink.tsx)
// rather than an eager bulk pass over a whole transcript: a long transcript
// may mention the same handful of paths dozens of times, and only the ones
// actually on screen ever trigger a lookup.
// ---------------------------------------------------------------------------

let projectRootsPromise: Promise<ProjectRoot[]> | null = null;

/** Cached project.list → {name, path}. Failure clears the cache so the next
 * caller retries rather than being stuck on a permanently-rejected promise. */
export function loadProjectRoots(request: RequestFn): Promise<ProjectRoot[]> {
  if (!projectRootsPromise) {
    projectRootsPromise = request<Array<Record<string, unknown>>>("project.list", {})
      .then((rows) => rows.map((r) => ({ name: String(r["name"] ?? ""), path: String(r["path"] ?? "") })))
      .catch((err: unknown) => {
        projectRootsPromise = null;
        throw err;
      });
  }
  return projectRootsPromise;
}

/** Test-only: drop the memoized project-roots promise between cases. */
export function resetProjectRootsCache(): void {
  projectRootsPromise = null;
}

const resolutionCache = new Map<string, Promise<PathResolution>>();

/** One raw path -> one RPC, cached by the raw text.
 *
 *  PATH-LINK-ONE-ROUNDTRIP: this used to run the candidate walk HERE, probing each registered
 *  project with its own `fs.read` and keeping the first that answered. That is N sequential round
 *  trips per rendered link with N-1 expected failures — measured at 10 projects, so 10 RPCs and 9
 *  logged daemon errors per link, 305 failures a minute across a busy transcript. Every one of
 *  them queued on the daemon's single thread, ahead of and behind real requests, and it fed back
 *  on itself: the slower the daemon got, the longer each of the ten probes took.
 *
 *  The walk is a filesystem question, so it belongs where the filesystem is — `fs.resolve` does
 *  the same candidate order with local stat calls, in microseconds, and answers once. */
export function resolvePathRefCached(
  rawPath: string,
  request: RequestFn,
): Promise<PathResolution> {
  const cached = resolutionCache.get(rawPath);
  if (cached) return cached;
  const p = request<{ project: string | null; relPath: string; result: FsReadResult } | null>(
    "fs.resolve", { path: rawPath },
  )
    .then((hit): PathResolution => (hit
      ? { status: "resolved", project: hit.project ?? WIDENED_ROOT_LABEL, relPath: hit.relPath, result: hit.result }
      : { status: "unresolved" }))
    // Unresolvable is the NORMAL outcome for prose that merely looks like a path, so a rejection
    // (an older daemon with no fs.resolve, a disconnect) renders as plain text rather than
    // surfacing an error the operator can do nothing about.
    .catch((): PathResolution => ({ status: "unresolved" }));
  resolutionCache.set(rawPath, p);
  return p;
}

/** Test-only: drop every cached resolution between cases. */
export function resetPathResolutionCache(): void {
  resolutionCache.clear();
}

// ---------------------------------------------------------------------------
// the path-viewer overlay's local store (which file, if any, is open) — same
// shape/singleton pattern as commands.artifacts.ts's artifactsLocal.
// ---------------------------------------------------------------------------

export type PathViewerLocalState = { selected: FsSelectedFile | null; project: string | null; line: number | null };
const initialPathViewerLocal: PathViewerLocalState = { selected: null, project: null, line: null };

export type PathViewerLocalStore = {
  getState(): PathViewerLocalState;
  set(patch: Partial<PathViewerLocalState>): void;
  subscribe(fn: () => void): () => void;
};

function createPathViewerLocal(): PathViewerLocalStore {
  let state = initialPathViewerLocal;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const fn of listeners) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** The app-wide path-viewer store. Any PathLink can open it; PathViewerCard
 * is registered once (overlays/index.ts) so it renders regardless of which
 * screen/transcript the click came from. */
export const pathViewerLocal: PathViewerLocalStore = createPathViewerLocal();

export function usePathViewerLocal<T>(selector: (s: PathViewerLocalState) => T): T {
  return useSyncExternalStore(pathViewerLocal.subscribe, () => selector(pathViewerLocal.getState()));
}

/** Open the viewer for an already-resolved path (PathLink only calls this
 * once resolvePathRefCached settled to "resolved" — never a dead click). */
export function openPathViewer(project: string, relPath: string, result: FsReadResult, line: number | null): void {
  pathViewerLocal.set({ selected: { path: relPath, status: "ok", result }, project, line });
}

export function closePathViewer(): void {
  pathViewerLocal.set({ selected: null, project: null, line: null });
}
