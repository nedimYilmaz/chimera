// Pure decision logic behind `scripts/check-laya-release.ts`, the command the daily
// `laya-release-integration` job runs. Kept free of I/O so the dedup contract is testable offline.
//
// "A newer Laya exists on PyPI" is NOT yet "work is needed": the same version may already be the pin,
// installed on this machine, or already dispatched as a task that has not landed. Without that dedup
// the job would re-dispatch the same upgrade every morning until someone merges it.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Plain numeric releases only ("0.3.27"). Pre-releases, dev builds and post-releases ("0.3.28rc1",
 * ".dev1", ".post1") return null on purpose: the job must never propose a candidate the pin policy
 * ("latest compatible STABLE") would refuse, and a mis-parsed suffix would sort wrongly anyway.
 */
export function parseStableVersion(v: string): number[] | null {
  return /^\d+(?:\.\d+){1,3}$/.test(v) ? v.split(".").map(Number) : null;
}

/** Numeric, segment-wise: 0.3.10 > 0.3.9 (a string compare gets this wrong). Throws on a non-stable version. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseStableVersion(a), parseStableVersion(b)];
  if (!x || !y) throw new RangeError(`not a stable version: ${x ? b : a}`);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export type LayaWheel = { file: string; url: string; sha256: string };
export type LayaLatest = { version: string; wheel: LayaWheel | null; uploadedAt: string | null };

/**
 * Highest non-yanked stable release in a PyPI JSON-API document. Computed from `releases` rather
 * than trusting `info.version`, which can name a yanked or pre-release upload. The wheel digest is
 * returned only as a CANDIDATE to compare with a second source; the repo pin is never taken from the
 * same response that supplies the artifact (see the header of scripts/integration-pins.mjs).
 */
export function latestStable(pypi: unknown): LayaLatest | null {
  if (!isObj(pypi) || !isObj(pypi.releases)) return null;
  let best: { version: string; files: Json[] } | null = null;
  for (const [version, files] of Object.entries(pypi.releases)) {
    if (!parseStableVersion(version) || !Array.isArray(files)) continue;
    const live = files.filter((f): f is Json => isObj(f) && f.yanked !== true);
    if (live.length === 0) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, files: live };
  }
  if (!best) return null;
  const wheel = best.files.find(f => f.packagetype === "bdist_wheel" && typeof f.filename === "string" && f.filename.endsWith("-py3-none-any.whl"));
  const sha256 = isObj(wheel?.digests) ? wheel.digests.sha256 : undefined;
  const uploaded = best.files.map(f => f.upload_time_iso_8601).find((t): t is string => typeof t === "string");
  return {
    version: best.version,
    wheel: wheel && typeof wheel.url === "string" && typeof sha256 === "string" ? { file: wheel.filename as string, url: wheel.url, sha256 } : null,
    uploadedAt: uploaded ?? null,
  };
}

/** `laya-0.3.27` (a directory under <home>/integrations) -> "0.3.27"; anything else -> null. */
export function layaVersionFromDir(name: string): string | null {
  const m = /^laya-(.+)$/.exec(name);
  return m && parseStableVersion(m[1]!) ? m[1]! : null;
}

export type LayaReleaseDecision =
  | { action: "upgrade"; version: string; reason: string }
  | { action: "none"; version: string | null; reason: string };

/**
 * `upgrade` only for a stable release strictly newer than everything already accounted for.
 * `installed` means a runtime that finished provisioning on THIS machine; `pending` means a version
 * already dispatched to the team (open task) but not yet pinned. A pending or installed version at or
 * above the candidate suppresses it -- a later release (pending 0.3.29 while PyPI says 0.3.28 after a
 * yank) must not spawn work for an older one.
 */
export function decideLayaRelease(i: { latest: string | null; pinned: string; installed: string[]; pending: string[] }): LayaReleaseDecision {
  const { latest, pinned } = i;
  if (!latest) return { action: "none", version: null, reason: "PyPI response has no stable, non-yanked release" };
  const c = compareVersions(latest, pinned);
  if (c === 0) return { action: "none", version: latest, reason: `${latest} is already the pinned version` };
  if (c < 0) return { action: "none", version: latest, reason: `PyPI latest ${latest} is older than the pin ${pinned} (yanked or republished?); not downgrading` };
  const covers = (versions: string[]) => versions.some(v => parseStableVersion(v) && compareVersions(v, latest) >= 0);
  if (covers(i.installed)) return { action: "none", version: latest, reason: `${latest} (or newer) is already installed on this machine but not pinned; finish the pin instead of re-dispatching` };
  if (covers(i.pending)) return { action: "none", version: latest, reason: `${latest} (or newer) is already pending` };
  return { action: "upgrade", version: latest, reason: `${latest} is newer than the pin ${pinned} and neither installed nor pending` };
}
