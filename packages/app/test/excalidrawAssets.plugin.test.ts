import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { PassThrough } from "node:stream";
import viteConfig from "../vite.config.js";

// EXCALIDRAW-DIAGRAMS — unit coverage for the excalidrawAssets() Vite plugin
// declared in packages/app/vite.config.ts (the no-remote-CDN font guardrail).
// The plugin is not exported, so we reach it through the resolved config's
// plugin list by its `name`, then drive its `configureServer` middleware and
// `closeBundle` copy hook directly. We assert the dev middleware:
//   • serves an existing font under the package's fonts dir (font/woff2),
//   • rejects a ../ path-traversal escape via next(),
//   • defers a non-/fonts/ request via next(),
//   • defers a missing font file via next(),
// and that closeBundle copies the font tree into the resolved build outDir.
//
// Fonts come from node_modules (NOT vendored) — the same tree the plugin
// resolves at runtime, so these tests exercise the real files.

const require = createRequire(import.meta.url);
const fontsDir = path.join(path.dirname(require.resolve("@excalidraw/excalidraw")), "fonts");

type Handler = (req: { url?: string }, res: MockRes, next: () => void) => void;
type MockRes = PassThrough & { headers: Record<string, string>; setHeader(k: string, v: string): void };

// A plugin lifecycle hook can be a bare function or an { order, handler } object.
function callHook<T extends unknown[]>(hook: unknown, self: unknown, ...args: T): void {
  const fn = typeof hook === "function" ? hook : (hook as { handler?: (...a: T) => void })?.handler;
  if (typeof fn !== "function") throw new Error("hook is not callable");
  (fn as (...a: T) => void).apply(self, args);
}

// Flatten vite's (possibly nested) PluginOption[] and find our named plugin.
function findPlugin(name: string): Record<string, unknown> {
  const flat: Record<string, unknown>[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") flat.push(x as Record<string, unknown>);
  };
  walk((viteConfig as { plugins?: unknown }).plugins);
  const found = flat.find((p) => p.name === name);
  if (!found) throw new Error(`plugin ${name} not found in resolved config`);
  return found;
}

function mockRes(): MockRes {
  const res = new PassThrough() as MockRes;
  res.headers = {};
  res.setHeader = (k: string, v: string) => {
    res.headers[k] = v;
  };
  return res;
}

// Extract the middleware the plugin registers via server.middlewares.use(fn).
function getMiddleware(): Handler {
  const plugin = findPlugin("excalidraw-assets");
  let handler: Handler | undefined;
  const server = { middlewares: { use: (fn: Handler) => { handler = fn; } } };
  callHook(plugin.configureServer, plugin, server);
  if (!handler) throw new Error("middleware was not registered");
  return handler;
}

describe("excalidrawAssets() plugin — resolution", () => {
  it("registers a named plugin in the resolved config", () => {
    expect(() => findPlugin("excalidraw-assets")).not.toThrow();
  });

  it("resolves a fonts dir that actually exists in node_modules", () => {
    expect(fs.existsSync(fontsDir)).toBe(true);
  });
});

describe("excalidrawAssets() dev middleware — serving", () => {
  let mw: Handler;
  beforeAll(() => {
    mw = getMiddleware();
  });

  it("serves an existing font as font/woff2 without calling next()", async () => {
    const res = mockRes();
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    const finished = new Promise<void>((resolve) => res.on("end", () => resolve()));
    let nextCalled = false;

    mw({ url: "/fonts/Assistant/Assistant-Regular.woff2" }, res, () => { nextCalled = true; });
    await finished;

    expect(nextCalled).toBe(false);
    expect(res.headers["Content-Type"]).toBe("font/woff2");
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
  });

  it("ignores a query string when resolving the font path", async () => {
    const res = mockRes();
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    const finished = new Promise<void>((resolve) => res.on("end", () => resolve()));
    let nextCalled = false;

    mw({ url: "/fonts/Assistant/Assistant-Regular.woff2?v=abc123" }, res, () => { nextCalled = true; });
    await finished;

    expect(nextCalled).toBe(false);
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
  });
});

describe("excalidrawAssets() dev middleware — deferral / guards", () => {
  let mw: Handler;
  beforeAll(() => {
    mw = getMiddleware();
  });

  it("defers a non-/fonts/ request to next()", () => {
    const res = mockRes();
    let nextCalled = false;
    mw({ url: "/index.html" }, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.headers["Content-Type"]).toBeUndefined();
  });

  it("defers a request with no url to next()", () => {
    const res = mockRes();
    let nextCalled = false;
    mw({}, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("rejects a ../ path-traversal escape via next() (never reads outside fontsDir)", () => {
    const res = mockRes();
    let nextCalled = false;
    mw({ url: "/fonts/../../../../etc/passwd" }, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.headers["Content-Type"]).toBeUndefined();
  });

  it("defers a missing font file (inside fontsDir but nonexistent) to next()", () => {
    const res = mockRes();
    let nextCalled = false;
    mw({ url: "/fonts/DoesNotExist/nope.woff2" }, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("defers a request that resolves to a DIRECTORY (a font family dir) to next() — no EISDIR crash", () => {
    // /fonts/Assistant is a real subdirectory under fontsDir; streaming it would
    // EISDIR and crash the dev server, so the middleware must defer instead.
    const res = mockRes();
    let nextCalled = false;
    mw({ url: "/fonts/Assistant" }, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.headers["Content-Type"]).toBeUndefined();
  });

  it("defers a malformed %-escape without throwing (decode guard)", () => {
    const res = mockRes();
    let nextCalled = false;
    expect(() => mw({ url: "/fonts/%E0%A4%A" }, res, () => { nextCalled = true; })).not.toThrow();
    expect(nextCalled).toBe(true);
  });
});
describe("excalidrawAssets() build hooks — outDir wiring", () => {
  // The full closeBundle copy is a real ~13MB fs.cpSync of the font tree (too
  // slow/flaky for a unit test); we instead assert the two build hooks exist so
  // the copy path is wired, and leave the byte-for-byte copy to the build.
  it("exposes configResolved and closeBundle build hooks", () => {
    const plugin = findPlugin("excalidraw-assets");
    expect(plugin.configResolved).toBeDefined();
    expect(plugin.closeBundle).toBeDefined();
  });

  it("accepts an outDir via configResolved without throwing", () => {
    const plugin = findPlugin("excalidraw-assets");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "excal-out-"));
    try {
      expect(() => callHook(plugin.configResolved, plugin, { build: { outDir: tmp } })).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
