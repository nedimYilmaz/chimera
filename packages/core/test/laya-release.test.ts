import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { compareVersions, decideLayaRelease, latestStable, layaVersionFromDir, parseStableVersion } from "../src/laya-release.js";

// Real, trimmed PyPI JSON-API response (see the fixture's `_note`), so the parser is pinned to the
// shape PyPI actually returns -- including the sdist next to each wheel and the 0.3.9 < 0.3.10 trap.
const PYPI = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/pypi-laya.json", import.meta.url)), "utf8"));
const { LAYA } = (await import(join(fileURLToPath(new URL("../../../scripts/", import.meta.url)), "integration-pins.mjs"))) as { LAYA: any };

const withRelease = (version: string, files: object[]) => ({ ...PYPI, releases: { ...PYPI.releases, [version]: files } });
const wheelFile = (version: string, extra: object = {}) => ({
  filename: `laya-${version}-py3-none-any.whl`, packagetype: "bdist_wheel", yanked: false,
  url: `https://files.pythonhosted.org/laya-${version}-py3-none-any.whl`, digests: { sha256: "ab".repeat(32) },
  upload_time_iso_8601: "2026-10-06T00:00:00.000000Z", ...extra,
});

describe("version parsing", () => {
  it("accepts plain numeric releases only", () => {
    expect(parseStableVersion("0.3.27")).toEqual([0, 3, 27]);
    expect(parseStableVersion("1.0")).toEqual([1, 0]);
    for (const bad of ["0.3.28rc1", "0.3.28.dev1", "0.3.28.post1", "0.3.28a1", "v0.3.28", "0", "", "0.3.", "0.3.27.1.2"]) expect(parseStableVersion(bad)).toBeNull();
  });
  it("orders numerically, not lexically", () => {
    expect(compareVersions("0.3.10", "0.3.9")).toBe(1);
    expect(compareVersions("0.3.9", "0.3.27")).toBe(-1);
    expect(compareVersions("0.3.27", "0.3.27")).toBe(0);
    expect(compareVersions("0.3", "0.3.0")).toBe(0);
    expect(compareVersions("0.4.0", "0.3.99")).toBe(1);
  });
  it("throws on a non-stable version instead of guessing an order", () => {
    expect(() => compareVersions("0.3.28rc1", "0.3.27")).toThrow(RangeError);
  });
  it("maps integration directory names to versions", () => {
    expect(layaVersionFromDir("laya-0.3.22")).toBe("0.3.22");
    for (const bad of ["laya", "laya-", "laya-0.3.28rc1", "chimera-browser", "laya-0.3.22.tmp"]) expect(layaVersionFromDir(bad)).toBeNull();
  });
});

describe("latestStable against the real PyPI index", () => {
  it("picks 0.3.28 and its pure-python wheel, not the sdist", () => {
    const latest = latestStable(PYPI)!;
    expect(latest.version).toBe("0.3.28");
    expect(latest.wheel).toMatchObject({ file: "laya-0.3.28-py3-none-any.whl", url: expect.stringMatching(/^https:\/\/files\.pythonhosted\.org\/.*\.whl$/) });
    expect(latest.uploadedAt).toMatch(/^2026-10-0\d/);
  });
  it("the wheel PyPI reports for the current pin is the digest and URL we pinned", () => {
    const wheel = latestStable(PYPI)!.wheel!;
    expect(LAYA.version).toBe("0.3.28");
    expect(wheel.sha256).toBe(LAYA.wheel.sha256);
    expect(wheel.url).toBe(LAYA.wheel.url);
    expect(wheel.file).toBe(LAYA.wheel.file);
  });
  it("sorts 0.3.10 above 0.3.9 when they are the newest entries", () => {
    const idx = { releases: { "0.3.9": PYPI.releases["0.3.9"], "0.3.10": PYPI.releases["0.3.10"] } };
    expect(latestStable(idx)!.version).toBe("0.3.10");
  });
  it("ignores a yanked newest release and falls back to the previous stable one", () => {
    const yanked = withRelease("0.3.28", [wheelFile("0.3.28", { yanked: true })]);
    expect(latestStable(yanked)!.version).toBe("0.3.27");
  });
  it("ignores pre-releases and releases with no files, whatever `info.version` claims", () => {
    const idx = { info: { version: "0.3.29rc1" }, releases: { ...PYPI.releases, "0.3.29rc1": [wheelFile("0.3.29rc1")], "0.3.28": [] } };
    expect(latestStable(idx)!.version).toBe("0.3.27");
  });
  it("reports a release that has no usable wheel with wheel: null instead of inventing one", () => {
    const sdistOnly = withRelease("0.3.28", [{ filename: "laya-0.3.28.tar.gz", packagetype: "sdist", yanked: false, url: "https://x/laya-0.3.28.tar.gz", digests: { sha256: "cd".repeat(32) } }]);
    expect(latestStable(sdistOnly)).toMatchObject({ version: "0.3.28", wheel: null });
  });
  it("a yanked wheel next to a live sdist is not offered as the wheel", () => {
    const idx = withRelease("0.3.28", [wheelFile("0.3.28", { yanked: true }), { filename: "laya-0.3.28.tar.gz", packagetype: "sdist", yanked: false, url: "https://x", digests: { sha256: "cd".repeat(32) } }]);
    expect(latestStable(idx)).toMatchObject({ version: "0.3.28", wheel: null });
  });
  it.each([null, undefined, 42, "x", [], {}, { releases: [] }, { releases: { "0.3.28rc1": [wheelFile("0.3.28rc1")] } }])("returns null for unusable input %j", input => {
    expect(latestStable(input)).toBeNull();
  });
  it("skips malformed file entries without throwing", () => {
    const idx = { releases: { "0.3.28": ["junk", null, { yanked: false }], "0.3.27": PYPI.releases["0.3.27"] } };
    expect(latestStable(idx)).toMatchObject({ version: "0.3.28", wheel: null });
  });
});

describe("pinned checkpoint metadata", () => {
  it("has a full 40-hex revision and 64-hex digests", () => {
    expect(LAYA.checkpoint.repo).toBe("convaiinnovations/laya");
    expect(LAYA.checkpoint.revision).toMatch(/^[0-9a-f]{40}$/);
    for (const [file, sha] of Object.entries(LAYA.checkpoint.files)) {
      expect(file).toMatch(/\.safetensors$/);
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("decideLayaRelease dedup contract", () => {
  const base = { pinned: "0.3.27", installed: [] as string[], pending: [] as string[] };
  it("dispatches a strictly newer stable release that is neither installed nor pending", () => {
    expect(decideLayaRelease({ ...base, latest: "0.3.28" })).toMatchObject({ action: "upgrade", version: "0.3.28" });
  });
  it("does nothing when the latest release is already the pin", () => {
    expect(decideLayaRelease({ ...base, latest: "0.3.27" })).toMatchObject({ action: "none", reason: expect.stringContaining("already the pinned") });
  });
  it("does not downgrade when PyPI's latest is older than the pin", () => {
    expect(decideLayaRelease({ ...base, latest: "0.3.26" })).toMatchObject({ action: "none", reason: expect.stringContaining("not downgrading") });
  });
  it("is silent while the same version is installed locally but not yet pinned", () => {
    expect(decideLayaRelease({ ...base, latest: "0.3.28", installed: ["0.3.22", "0.3.28"] })).toMatchObject({ action: "none", reason: expect.stringContaining("installed") });
  });
  it("is silent while the same version is already dispatched", () => {
    expect(decideLayaRelease({ ...base, latest: "0.3.28", pending: ["0.3.28"] })).toMatchObject({ action: "none", reason: expect.stringContaining("pending") });
  });
  it("a newer pending or installed version also suppresses an older candidate", () => {
    expect(decideLayaRelease({ ...base, latest: "0.3.28", pending: ["0.3.29"] }).action).toBe("none");
    expect(decideLayaRelease({ ...base, latest: "0.3.28", installed: ["0.3.30"] }).action).toBe("none");
  });
  it("an OLDER pending/installed version does not suppress a newer release", () => {
    expect(decideLayaRelease({ ...base, latest: "0.3.28", installed: ["0.3.22"], pending: ["0.3.26"] }).action).toBe("upgrade");
  });
  it("compares numerically when deduping (0.3.9 pending does not cover 0.3.10)", () => {
    expect(decideLayaRelease({ pinned: "0.3.8", latest: "0.3.10", installed: [], pending: ["0.3.9"] }).action).toBe("upgrade");
  });
  it("ignores unparseable entries in the installed/pending lists", () => {
    expect(decideLayaRelease({ ...base, latest: "0.3.28", installed: ["junk"], pending: ["0.3.29rc1", ""] }).action).toBe("upgrade");
  });
  it("does nothing when there is no stable release at all", () => {
    expect(decideLayaRelease({ ...base, latest: null })).toMatchObject({ action: "none", version: null });
  });
  it("end to end on the real index: the repo is up to date today", () => {
    const latest = latestStable(PYPI)!;
    expect(decideLayaRelease({ ...base, pinned: LAYA.version, latest: latest.version }).action).toBe("none");
  });
});
