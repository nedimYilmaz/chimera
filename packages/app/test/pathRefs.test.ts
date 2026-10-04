import { beforeEach, describe, expect, it } from "vitest";
import type { FsReadResult } from "@chimera/protocol";
import {
  candidateRoots,
  isPathUnderRoot,
  normalizePosixPath,
  relPathUnder,
  resetPathResolutionCache,
  resetProjectRootsCache,
  resolvePathRef,
  resolvePathRefCached,
  WIDENED_ROOT_LABEL,
  type ProjectRoot,
} from "../src/state/pathRefs";

// FILE-PATH-LINKS — pathRefs.ts is the client-side half of "click a path in
// the transcript, see the file": which registered project (if any) a raw
// path string belongs to, and the RPC orchestration (fs.read, cached) that
// reads it. The AUTHORITATIVE confinement/traversal/size/binary checks live
// server-side in packages/core/src/fsbrowse.ts (already covered by
// fsbrowse.test.ts's own escape-path/oversized/binary cases — resolveWithinProject
// realpath-checks BOTH the project root and the target, so a symlink escape
// can't slip through either side). What's tested HERE is this module's OWN
// client-side pre-filter: it must reject an escaping path (resolve-then-check,
// not a naive string-prefix test) BEFORE ever issuing an RPC, and it must
// degrade every failure (no candidate, a refused read) to "unresolved"
// without throwing.

const root = "/Users/alice/Documents/Personal/chimera";
const projects: ProjectRoot[] = [{ name: "chimera", path: root }];

const okResult: FsReadResult = {
  path: "packages/core/src/foo.ts",
  encoding: "utf8",
  content: "export const x = 1;\n",
  sizeBytes: 21,
  binary: false,
  mediaType: null,
  truncated: false,
};

describe("normalizePosixPath", () => {
  it("resolves . and .. segments", () => {
    expect(normalizePosixPath("/a/b/../c")).toBe("/a/c");
    expect(normalizePosixPath("/a/./b")).toBe("/a/b");
    expect(normalizePosixPath("a/b/../../c")).toBe("c");
  });

  it("absorbs a leading .. past an absolute root (can't go above /)", () => {
    expect(normalizePosixPath("/../../etc/passwd")).toBe("/etc/passwd");
  });

  it("keeps a relative path's leading .. (nothing to absorb it into)", () => {
    expect(normalizePosixPath("../a/b")).toBe("../a/b");
  });
});

describe("isPathUnderRoot / candidateRoots — resolve-then-check traversal defense", () => {
  it("accepts a plain path under the root", () => {
    expect(isPathUnderRoot(`${root}/packages/core/src/foo.ts`, root)).toBe(true);
  });

  it("never confuses a sibling whose name prefixes the root (/a/bc vs /a/b)", () => {
    expect(isPathUnderRoot("/Users/alice/Documents/Personal/chimera-evil/x", root)).toBe(false);
  });

  // The exact acceptance-test path: chimera/../../../../etc/passwd normalizes
  // to /Users/etc/passwd (four ".." pop chimera, Personal, Documents, alice),
  // which is NOT under the chimera project root — a naive string-prefix check
  // on the RAW text would wrongly say "starts with root" and hand fs.read an
  // escaping relPath; the normalize-first check here catches it before that.
  it("REFUSES a ../../../../ traversal out of the project root — never becomes a read candidate", async () => {
    const traversal = `${root}/../../../../etc/passwd`;
    expect(normalizePosixPath(traversal)).toBe("/Users/etc/passwd");
    expect(isPathUnderRoot(traversal, root)).toBe(false);
    expect(candidateRoots(traversal, projects)).toEqual([]);

    // End-to-end: resolvePathRef must settle to "unresolved" WITHOUT ever
    // calling readFile (no candidate root survived the pre-filter).
    let readFileCalled = false;
    const resolution = await resolvePathRef(
      traversal,
      async () => projects,
      async () => {
        readFileCalled = true;
        throw new Error("must never be called for an escaping path");
      },
    );
    expect(resolution).toEqual({ status: "unresolved" });
    expect(readFileCalled).toBe(false);
  });

  it("picks the most specific (longest) root when projects nest", () => {
    const nested: ProjectRoot[] = [
      { name: "outer", path: "/Users/alice/Documents" },
      { name: "inner", path: root },
    ];
    const candidates = candidateRoots(`${root}/packages/core/foo.ts`, nested);
    expect(candidates[0]).toEqual({ project: "inner", relPath: "packages/core/foo.ts" });
  });

  it("tries every registered project for a repo-relative path", () => {
    const multi: ProjectRoot[] = [{ name: "a", path: "/x" }, { name: "b", path: "/y" }];
    expect(candidateRoots("packages/core/foo.ts", multi)).toEqual([
      { project: "a", relPath: "packages/core/foo.ts" },
      { project: "b", relPath: "packages/core/foo.ts" },
    ]);
  });

  // PATH-LINK-TILDE-AND-SCOPE: a "~"-path is never a registered-project
  // candidate — this module doesn't know the real OS home dir to pre-filter
  // it (see resolvePathRef's separate readAbsolute fallback, which is the
  // ONLY path a "~" ever resolves through).
  it("never treats a ~-path as a repo-relative candidate (empty, not a blind per-project guess)", () => {
    expect(candidateRoots("~/Documents/acmecorp/report.md", projects)).toEqual([]);
    expect(candidateRoots("~", projects)).toEqual([]);
  });
});

describe("relPathUnder", () => {
  it("strips the root prefix", () => {
    expect(relPathUnder(root, `${root}/packages/core/foo.ts`)).toBe("packages/core/foo.ts");
  });

  it("returns empty string for the root itself", () => {
    expect(relPathUnder(root, root)).toBe("");
  });
});

describe("resolvePathRef", () => {
  it("resolves an absolute path under a registered project", async () => {
    const resolution = await resolvePathRef(
      `${root}/packages/core/src/foo.ts`,
      async () => projects,
      async (project, relPath) => {
        expect(project).toBe("chimera");
        expect(relPath).toBe("packages/core/src/foo.ts");
        return okResult;
      },
    );
    expect(resolution).toEqual({ status: "resolved", project: "chimera", relPath: "packages/core/src/foo.ts", result: okResult });
  });

  it("falls through to the next candidate project when the first fs.read refuses", async () => {
    const multi: ProjectRoot[] = [{ name: "a", path: "/x" }, { name: "b", path: "/y" }];
    const resolution = await resolvePathRef(
      "src/foo.ts",
      async () => multi,
      async (project) => {
        if (project === "a") throw new Error("no such file");
        return okResult;
      },
    );
    expect(resolution).toEqual({ status: "resolved", project: "b", relPath: "src/foo.ts", result: okResult });
  });

  it("settles to unresolved (never throws) when every candidate fails", async () => {
    const resolution = await resolvePathRef(
      "src/nope.ts",
      async () => projects,
      async () => { throw new Error("no such file"); },
    );
    expect(resolution).toEqual({ status: "unresolved" });
  });

  it("settles to unresolved when there is no registered project at all", async () => {
    const resolution = await resolvePathRef(
      "src/foo.ts",
      async () => [],
      async () => okResult,
    );
    expect(resolution).toEqual({ status: "unresolved" });
  });

  // The viewer must "refuse/handle" an oversized or binary file gracefully —
  // fs.read's server-side contract (fsbrowse.test.ts) is either a rejection
  // (over ARTIFACT_MAX_BYTES) or a binary:true result with empty content; this
  // module must never crash on either, and a rejection must not be mistaken
  // for "resolved".
  it("treats a server-side too-large refusal as unresolved, not a crash", async () => {
    const resolution = await resolvePathRef(
      `${root}/packages/core/big.bin`,
      async () => projects,
      async () => { throw new Error('"packages/core/big.bin" is 9999999 bytes, over the cap — refused'); },
    );
    expect(resolution).toEqual({ status: "unresolved" });
  });

  it("passes a binary FsReadResult through as resolved (the viewer pane decides how to render it)", async () => {
    const binary: FsReadResult = { ...okResult, content: "", binary: true, mediaType: null };
    const resolution = await resolvePathRef(
      `${root}/packages/core/tool`,
      async () => projects,
      async () => binary,
    );
    expect(resolution).toEqual({ status: "resolved", project: "chimera", relPath: "packages/core/tool", result: binary });
  });

  // PATH-LINK-TILDE-AND-SCOPE: the widened-root fallback (readAbsolute, the
  // NEW optional 4th param) — omitting it (every test above) keeps the exact
  // prior behavior; these cases prove the addition is opt-in and additive.
  describe("readAbsolute fallback (widened roots)", () => {
    it("is never called when a registered project already resolved it", async () => {
      let readAbsoluteCalled = false;
      const resolution = await resolvePathRef(
        `${root}/packages/core/src/foo.ts`,
        async () => projects,
        async () => okResult,
        async () => { readAbsoluteCalled = true; throw new Error("must not be called"); },
      );
      expect(resolution).toEqual({ status: "resolved", project: "chimera", relPath: "packages/core/src/foo.ts", result: okResult });
      expect(readAbsoluteCalled).toBe(false);
    });

    it("resolves a ~-path via readAbsolute when no registered project claims it", async () => {
      const resolution = await resolvePathRef(
        "~/Documents/acmecorp/report.md",
        async () => projects,
        async () => { throw new Error("must never be tried as a registered-project candidate"); },
        async (rawPath) => {
          expect(rawPath).toBe("~/Documents/acmecorp/report.md");
          return okResult;
        },
      );
      expect(resolution).toEqual({ status: "resolved", project: WIDENED_ROOT_LABEL, relPath: okResult.path, result: okResult });
    });

    it("resolves an absolute path outside every registered project via readAbsolute", async () => {
      const resolution = await resolvePathRef(
        "/Users/alice/Documents/acmecorp/report.md",
        async () => projects,               // none of these roots contain this path
        async () => { throw new Error("no such file"); },
        async () => okResult,
      );
      expect(resolution).toEqual({ status: "resolved", project: WIDENED_ROOT_LABEL, relPath: okResult.path, result: okResult });
    });

    it("settles to unresolved (never throws) when readAbsolute also refuses — e.g. ~/.ssh/id_rsa", async () => {
      const resolution = await resolvePathRef(
        "~/.ssh/id_rsa",
        async () => projects,
        async () => { throw new Error("must never be tried as a registered-project candidate"); },
        async () => { throw new Error("path is outside every allowed root"); },
      );
      expect(resolution).toEqual({ status: "unresolved" });
    });

    it("never tries readAbsolute for a plain repo-relative path (only absolute/~ shapes)", async () => {
      let readAbsoluteCalled = false;
      const resolution = await resolvePathRef(
        "src/nope.ts",
        async () => projects,
        async () => { throw new Error("no such file"); },
        async () => { readAbsoluteCalled = true; return okResult; },
      );
      expect(resolution).toEqual({ status: "unresolved" });
      expect(readAbsoluteCalled).toBe(false);
    });
  });
});

describe("resolvePathRefCached / loadProjectRoots — session caching", () => {
  beforeEach(() => {
    resetProjectRootsCache();
    resetPathResolutionCache();
  });

  // PATH-LINK-ONE-ROUNDTRIP: one rendered link = ONE rpc. It used to be one per registered
  // project — 10 round trips and 9 expected failures on the operator's machine, all queued on the
  // daemon's single thread — so "how many calls" is the property under test, not an detail.
  it("asks the daemon ONCE, not once per project", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const request = async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === "fs.resolve") return { project: "chimera", relPath: "a.ts", result: okResult } as unknown as T;
      throw new Error(`unexpected method ${method}`);
    };
    const resolution = await resolvePathRefCached(`${root}/a.ts`, request);
    expect(resolution).toEqual({ status: "resolved", project: "chimera", relPath: "a.ts", result: okResult });
    expect(calls).toEqual([{ method: "fs.resolve", params: { path: `${root}/a.ts` } }]);
  });

  it("resolves the SAME raw path only once (second call reuses the cached promise)", async () => {
    let resolveCalls = 0;
    const request = async <T,>(method: string): Promise<T> => {
      if (method === "fs.resolve") { resolveCalls++; return { project: "chimera", relPath: "a.ts", result: okResult } as unknown as T; }
      throw new Error(`unexpected method ${method}`);
    };
    const path = `${root}/a.ts`;
    const [first, second] = await Promise.all([resolvePathRefCached(path, request), resolvePathRefCached(path, request)]);
    expect(first).toEqual(second);
    expect(resolveCalls).toBe(1);
  });

  // PATH-LINK-TILDE-AND-SCOPE: a path outside every registered project still resolves, and the
  // daemon reports it with no project name — rendered under the widened-root label as before.
  it("labels a widened-root hit (no project) with the ~ stand-in", async () => {
    const request = async <T,>(method: string): Promise<T> => {
      if (method === "fs.resolve") return { project: null, relPath: okResult.path, result: okResult } as unknown as T;
      throw new Error(`unexpected method ${method}`);
    };
    const resolution = await resolvePathRefCached("~/Documents/acmecorp/report.md", request);
    expect(resolution).toEqual({ status: "resolved", project: WIDENED_ROOT_LABEL, relPath: okResult.path, result: okResult });
  });

  it("renders as plain text when nothing holds the path, and when the call itself fails", async () => {
    // Prose that merely LOOKS like a path is the common case, so neither a null answer nor a
    // rejection (an older daemon, a disconnect) may surface as an error the operator can act on.
    const miss = async <T,>(): Promise<T> => null as unknown as T;
    expect(await resolvePathRefCached("not/a/real/file.ts", miss)).toEqual({ status: "unresolved" });
    const boom = async <T,>(): Promise<T> => { throw new Error("daemon says no"); };
    expect(await resolvePathRefCached("another/miss.ts", boom)).toEqual({ status: "unresolved" });
  });
});
