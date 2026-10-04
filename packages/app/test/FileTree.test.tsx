import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, create } from "react-test-renderer";
import type { FsDirState, ProjectDetail } from "../src/state/commands.projects";

// FILEBROWSER-T6 gate: (1) the pure flatten/filter/gitignore-toggle logic in
// isolation, (2) a render + keyboard-nav pass through the REAL projectsLocal +
// appStore singletons (FileTree is self-contained, no props — it reads
// detail/filesIdx/filesFocused off projectsLocal exactly like ProjectsScreen
// does, see FileTree.tsx's header comment) driven via runAction — the same
// dispatch path the root keydown handler uses, not raw DOM events (this tree
// has no DOM tabindex nav). The rpc/bridge mock (SpawnCard.test.tsx's own
// precedent) keeps fs.list/fs.read off any real Tauri IPC.

if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}

const ROOT: FsDirState = {
  status: "ok",
  truncated: false,
  entries: [
    { name: "src", kind: "dir", sizeBytes: null, gitStatus: null },
    { name: "README.md", kind: "file", sizeBytes: 120, gitStatus: "modified" },
    { name: "secret.log", kind: "file", sizeBytes: 10, gitStatus: "ignored" },
  ],
};

const SRC: FsDirState = {
  status: "ok",
  truncated: false,
  entries: [{ name: "index.ts", kind: "file", sizeBytes: 40, gitStatus: "staged" }],
};

const rpcImpl = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  if (method === "fs.list") {
    const p = (params as { path: string }).path;
    const dir = p === "src" ? SRC : ROOT;
    return { path: p, entries: dir.status === "ok" ? dir.entries : [], truncated: false };
  }
  if (method === "fs.read") {
    return { path: (params as { path: string }).path, encoding: "utf8", content: "hi", sizeBytes: 2, binary: false, mediaType: null, truncated: false };
  }
  return [];
});

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: (method: string, params?: unknown) => rpcImpl(method, params),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
  readArtifactSnapshot: vi.fn(async () => ""),
  openArtifactSnapshot: vi.fn(async () => {}),
  openArtifactUrl: vi.fn(async () => {}),
  setDockBadge: vi.fn(async () => {}),
  exportCsv: vi.fn(async () => ""),
  checkpointFilesSince: vi.fn(async () => 0),
}));

import { FileTree, classifyFsError, flattenFileTree } from "../src/screens/FileTree";
import { projectsLocal } from "../src/state/commands.projects";
import { runAction } from "../src/keymap";
import { appStore } from "../src/state/store";

describe("flattenFileTree — pure filter/gitignore/truncation logic", () => {
  it("hides ignored entries by default, shows them when toggled on", () => {
    const dirs = { "": ROOT };
    const hidden = flattenFileTree(dirs, new Set(), "", false);
    expect(hidden.map((r) => (r as { name?: string }).name)).not.toContain("secret.log");
    const shown = flattenFileTree(dirs, new Set(), "", true);
    expect(shown.map((r) => (r as { name?: string }).name)).toContain("secret.log");
  });

  it("narrows to entries matching the filter query, un-fetched subtrees produce no rows", () => {
    const dirs = { "": ROOT };
    const rows = flattenFileTree(dirs, new Set(), "readme", false);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { name: string }).name).toBe("README.md");
  });

  it("keeps an expanded dir visible (via a matching descendant) even when its own name doesn't match", () => {
    const dirs = { "": ROOT, src: SRC };
    const rows = flattenFileTree(dirs, new Set(["src"]), "index", false);
    const names = rows.map((r) => (r as { name?: string }).name);
    expect(names).toEqual(["src", "index.ts"]);
  });

  it("emits a truncated-dir note", () => {
    const dirs = { "": { ...ROOT, truncated: true } };
    const rows = flattenFileTree(dirs, new Set(), "", false);
    expect(rows.some((r) => r.type === "truncated")).toBe(true);
  });

  it("a dir not yet in the cache renders as loading, not empty — the lazy-expand-in-flight case", () => {
    const dirs = { "": ROOT }; // "src" expanded but its fs.list hasn't resolved yet
    const rows = flattenFileTree(dirs, new Set(["src"]), "", false);
    const loading = rows.filter((r) => r.type === "loading");
    expect(loading).toHaveLength(1);
    expect(loading[0]).toMatchObject({ path: "src" });
  });

  it("a non-git dir (all entries gitStatus:null) still lists its entries", () => {
    const NON_GIT: FsDirState = {
      status: "ok",
      truncated: false,
      entries: [
        { name: "a.txt", kind: "file", sizeBytes: 1, gitStatus: null },
        { name: "sub", kind: "dir", sizeBytes: null, gitStatus: null },
      ],
    };
    const rows = flattenFileTree({ "": NON_GIT }, new Set(), "", false);
    expect(rows.map((r) => (r as { name?: string }).name)).toEqual(["sub", "a.txt"]);
    expect(rows.every((r) => r.type === "entry" && r.gitStatus === null)).toBe(true);
  });

  it("FILEBROWSER-T9 acceptance: deleting the project path (root fs.list ENOENT) surfaces as an inline 'path unavailable' row, never a throw", () => {
    const dirs = { "": { status: "error" as const, message: 'no such file or directory: ""' } };
    const rows = flattenFileTree(dirs, new Set(), "", false);
    expect(rows).toEqual([{ type: "error", path: "", depth: 0, message: "path unavailable" }]);
  });
});

describe("classifyFsError — friendlier inline labels for the daemon's fs.list refusals", () => {
  it("maps an ENOENT-shaped message to 'path unavailable'", () => {
    expect(classifyFsError('no such file or directory: "sub"')).toBe("path unavailable");
  });

  it("maps an EACCES-shaped message to 'permission denied'", () => {
    expect(classifyFsError("EACCES: permission denied, scandir '/x'")).toBe("permission denied");
  });

  it("passes through anything it can't classify verbatim (e.g. a scope-escape refusal)", () => {
    expect(classifyFsError('path escapes project root: "../x"')).toBe('path escapes project root: "../x"');
  });
});

function seedDetail(): ProjectDetail {
  const detail: ProjectDetail = {
    spec: { name: "demo" },
    sessions: [],
    teams: [],
    queuePending: null,
    checkpoints: null,
    files: { dirs: { "": ROOT }, selected: null },
  };
  projectsLocal.set({ detail });
  return detail;
}

// expandDir/selectFile go over the (mocked) rpc seam — the keymap handler
// fires them off (`void commands.expandDir(...)`), so each action needs a
// microtask flush before its call is observable.
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

// A never-unmounted instance from a PRIOR test stays subscribed to the shared
// projectsLocal singleton and keeps re-registering keymap handlers on every
// store update, racing the current test's own registrations (the registry's
// "last registration wins" contract, PLUS-1'd by a zombie). Track the one
// live renderer per test and always unmount it.
let mounted: ReturnType<typeof create> | null = null;
function mount(): ReturnType<typeof create> {
  act(() => {
    mounted = create(React.createElement(FileTree));
  });
  return mounted;
}

beforeEach(() => {
  rpcImpl.mockClear();
  projectsLocal.reset();
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
});

describe("FileTree — render + keyboard nav (store-index convention)", () => {
  it("renders lazy tree rows with data-project-file-row hooks", () => {
    seedDetail();
    const renderer = mount();
    const rows = renderer.root.findAll((n) => "data-project-file-row" in n.props);
    expect(rows.map((r) => r.props["data-project-file-row"])).toEqual(["src", "README.md"]); // ignored hidden by default
  });

  it("claims filesFocused while mounted and releases it on unmount", () => {
    seedDetail();
    expect(projectsLocal.getState().filesFocused).toBe(false);
    const renderer = mount();
    expect(projectsLocal.getState().filesFocused).toBe(true);
    act(() => renderer.unmount());
    mounted = null;
    expect(projectsLocal.getState().filesFocused).toBe(false);
  });

  it("up/down/right/enter/left drive filesIdx, expand-fetch (one fs.list), and file selection", async () => {
    seedDetail();
    mount();
    expect(projectsLocal.getState().filesIdx).toBe(0); // "src" row

    // right on the collapsed "src" dir expands it — exactly one fs.list for "src"
    act(() => runAction("projects.filesRight", appStore));
    await flush();
    expect(rpcImpl.mock.calls.filter(([m, p]) => m === "fs.list" && (p as { path: string }).path === "src")).toHaveLength(1);

    // re-expanding (right again — already expanded, this branch no-ops) must NOT refetch
    act(() => runAction("projects.filesRight", appStore));
    await flush();
    expect(rpcImpl.mock.calls.filter(([m, p]) => m === "fs.list" && (p as { path: string }).path === "src")).toHaveLength(1);

    // down twice: src -> index.ts -> README.md
    act(() => runAction("projects.down", appStore));
    act(() => runAction("projects.down", appStore));
    expect(projectsLocal.getState().filesIdx).toBe(2);

    // enter on the file README.md reads it
    act(() => runAction("projects.drill", appStore));
    await flush();
    expect(rpcImpl.mock.calls.some(([m, p]) => m === "fs.read" && (p as { path: string }).path === "README.md")).toBe(true);

    // left on README.md: a top-level file has no visible parent row (root
    // itself is never rendered), so this is a no-op — cursor stays put
    act(() => runAction("projects.filesLeft", appStore));
    expect(projectsLocal.getState().filesIdx).toBe(2);

    // left on the expanded "src" dir collapses it — the row count shrinks
    // back to 2 (src, README.md) and the cursor clamps into range
    act(() => runAction("projects.up", appStore));
    act(() => runAction("projects.up", appStore));
    expect(projectsLocal.getState().filesIdx).toBe(0); // back on "src"
    act(() => runAction("projects.filesLeft", appStore));
    expect(projectsLocal.getState().filesIdx).toBe(0);
  });

  it("FILEBROWSER-T9 acceptance: expanding a folder shows a brief loading row until fs.list resolves", async () => {
    seedDetail();
    let resolveFetch: (v: unknown) => void = () => {};
    rpcImpl.mockImplementationOnce(
      (method: string) =>
        new Promise((resolve) => {
          if (method !== "fs.list") { resolve([]); return; }
          resolveFetch = resolve;
        }),
    );
    const renderer = mount();

    // expand "src" — the fetch is deliberately left pending
    act(() => runAction("projects.filesRight", appStore));
    const loadingRows = renderer.root.findAll((n) => "data-project-file-loading" in n.props);
    expect(loadingRows.map((r) => r.props["data-project-file-loading"])).toEqual(["src"]);

    await act(async () => {
      resolveFetch({ path: "src", entries: SRC.entries, truncated: false });
      await Promise.resolve();
    });
    expect(renderer.root.findAll((n) => "data-project-file-loading" in n.props)).toHaveLength(0);
    const rows = renderer.root.findAll((n) => "data-project-file-row" in n.props);
    expect(rows.map((r) => r.props["data-project-file-row"])).toContain("src/index.ts");
  });
});
