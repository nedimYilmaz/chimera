// MEM-6 §5.3 — runs the memory-graph perf harness in headless Chrome and prints
// the measured numbers. Dev-only; needs a local Chrome. Not wired into CI.
//
//   node packages/app/perf/run-bench.mjs
//
// Steps: esbuild-bundle the harness → serve it + a /result collector on a local
// port → launch Chrome headless → wait for the POSTed result → print + exit.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// esbuild lives nested in the pnpm store (not linked at any node_modules root);
// find its versioned dir under the repo root .pnpm store and require it directly.
function resolveEsbuild() {
  const store = join(HERE, "../../..", "node_modules", ".pnpm");
  const dir = readdirSync(store).find((d) => d.startsWith("esbuild@"));
  if (!dir) throw new Error("esbuild not found in pnpm store");
  return require(join(store, dir, "node_modules", "esbuild"));
}
const esbuild = resolveEsbuild();

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const TOKENS = `:root{
  --bg:#14161a; --panel:#171a1f; --fg:#d7dbe2; --fg-soft:#a9b0bc; --muted:#828b9a;
  --line:#262b34; --line-strong:#2e3342; --accent:#9aa3f2; --success:#79c58c;
  --warn:#d6b06a; --human:#d78ad0; --danger:#e2766f;
}`;

async function main() {
  const build = await esbuild.build({
    entryPoints: [join(HERE, "memory-graph-bench.entry.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  const js = build.outputFiles[0].text;

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${TOKENS}
    html,body{margin:0;background:var(--bg)}#c{display:block}</style></head>
    <body><canvas id="c"></canvas><script>${js}</script></body></html>`;

  let resolveResult;
  const resultP = new Promise((r) => (resolveResult = r));
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/result") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200).end("ok");
        resolveResult(JSON.parse(body || "{}"));
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;

  const profile = mkdtempSync(join(tmpdir(), "chgraph-"));
  const dsf = process.env.DSF ? [`--force-device-scale-factor=${process.env.DSF}`] : [];
  // GPU on by default (representative of a real Retina Mac); NOGPU=1 forces the
  // software rasterizer, which is NOT representative of on-device canvas 2D.
  const gpu = process.env.NOGPU ? ["--disable-gpu"] : ["--enable-gpu", "--ignore-gpu-blocklist"];
  const chrome = spawn(CHROME, [
    "--headless=new",
    ...gpu,
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--window-size=1500,1000",
    ...dsf,
    url,
  ]);
  chrome.on("error", (e) => {
    console.error("chrome launch failed:", e.message);
    process.exit(2);
  });

  const timeout = setTimeout(() => {
    console.error("timed out waiting for result");
    chrome.kill("SIGKILL");
    server.close();
    process.exit(3);
  }, 60000);

  const result = await resultP;
  clearTimeout(timeout);
  chrome.kill("SIGKILL");
  server.close();

  console.log("\n=== memory-graph perf (headless Chrome) ===");
  console.log(JSON.stringify(result, null, 2));
  if (result.error) process.exit(1);
  const ok = result.fps >= 58 && result.idleFrames === 0;
  console.log(`\nVERDICT: ${ok ? "PASS" : "FAIL"} — target 60fps @ 2k/4k, idle rAF = 0`);
  console.log(
    `  mean ${result.meanMs}ms (${result.fps}fps) · p95 ${result.p95Ms}ms · max ${result.maxMs}ms · idleFrames ${result.idleFrames}`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
