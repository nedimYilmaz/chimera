// Fixture server for the usage-video capture (scripts/marketing-video.mjs): the same Vite
// stand-in as scripts/marketing-preview.mjs (real React screens on the real app store, a mocked RPC
// bridge, nothing that reaches a daemon, provider, account or network) but serving the VIDEO entry
// packages/app/test/fixtures/marketing-video.tsx inside a shell that carries the on-video layer:
// the caption bar, the title card and the pointer overlay.
//
// marketing-preview.mjs stays untouched on purpose (it is the screenshot gate's tool); the plugin
// below is a copy, so a change to the bridge seams there has to be mirrored here.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Geometry of the on-video layer, shared with the capture script so pointer maths and the mobile
 * legibility numbers come from one place. */
export const FRAME = { width: 1280, height: 800, caption: 76, captionFont: 44 };

const SHELL_CSS = `
  html, body { margin: 0; background: #000; overflow: hidden; }
  body { width: ${FRAME.width}px; height: ${FRAME.height}px; position: relative; }
  /* The real screens size themselves with 100vw/100vh inline; pin them into the area the
     caption bar leaves free, so no UI is ever drawn underneath burned-in text. */
  #mv-stage { position: fixed; top: ${FRAME.caption}px; left: 0; right: 0; bottom: 0; overflow: hidden; }
  #root { transform-origin: 0 0; position: absolute; top: 0; left: 0; right: 0; bottom: 0; overflow: hidden; }
  #root > div { width: 100% !important; height: 100% !important; }
  /* Frames are sampled at a fixed rate, so a CSS transition caught mid-flight (or a looping spinner at an
     arbitrary phase) would make two captures differ. Every frame shows a settled state instead. */
  [class*="connRtt"] { display: none !important; }
  * { caret-color: transparent !important; scroll-behavior: auto !important; }
  *, *::before, *::after { animation: none !important; transition: none !important; }
  #mv-caption { position: fixed; left: 0; right: 0; box-sizing: border-box; display: flex; align-items: center; justify-content: center; text-align: center; font: 600 ${FRAME.captionFont}px/1.15 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #fff; padding: 0 20px; }
  #mv-caption { top: 0; height: ${FRAME.caption}px; background: #101418; border-top: 2px solid #2b3540; font-size: ${FRAME.captionFont}px; font-weight: 500; }
  #mv-title { position: fixed; inset: 0; z-index: 10; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 22px; background: radial-gradient(ellipse at 25% 20%, #1a382b, #0b0f14 70%); color: #fff; font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; text-align: center; padding: 0 64px; }
  #mv-title[data-on] { display: flex; }
  #mv-title h1 { margin: 0; font-size: 64px; line-height: 1.1; }
  #mv-title p { margin: 0; font-size: 34px; line-height: 1.25; color: #c9d4e0; }
  #mv-cursor { position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 20; pointer-events: none; display: none; }
  #mv-cursor[data-on] { display: block; }
  #mv-cursor svg { position: absolute; left: 0; top: 0; filter: drop-shadow(1px 2px 1px rgba(0,0,0,.55)); }
  #mv-cursor i { position: absolute; left: -18px; top: -18px; width: 36px; height: 36px; border-radius: 50%; border: 3px solid #ffd54a; background: rgba(255,213,74,.28); display: none; }
  #mv-cursor[data-down] i { display: block; }
`;

const SHELL = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Chimera workflow capture</title><style>${SHELL_CSS}</style></head><body>
<div id="mv-stage"><div id="root"></div></div>
<div id="mv-caption"></div>
<div id="mv-title"><div style="font-size:30px;letter-spacing:.2em;color:#8cddb0">CHIMERA</div><h1></h1><p></p></div>
<div id="mv-cursor"><svg width="26" height="34" viewBox="0 0 26 34"><path d="M2 2 L2 27 L8.5 21 L13 31.5 L17.5 29.5 L13 19.5 L22 19.5 Z" fill="#fff" stroke="#000" stroke-width="2" stroke-linejoin="round"/></svg><i></i></div>
<script type="module" src="/test/fixtures/marketing-video.tsx"></script>
</body></html>`;

/** Starts the fixture Vite server on a loopback port; resolves to `{ url, port, close }`. */
export async function startFixtureServer({ repoRoot, scratch }) {
  const require = createRequire(new URL("../packages/app/package.json", import.meta.url));
  const viteEntry = require.resolve("vite");
  const { createServer } = await import(pathToFileURL(viteEntry).href);
  const esbuild = createRequire(viteEntry)("esbuild");
  const vite = await createServer({
    root: resolve(repoRoot, "packages/app"),
    configFile: false,
    cacheDir: join(scratch, "vite"),
    esbuild: { jsx: "automatic" },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "marketing-video-fixture",
      enforce: "pre",
      resolveId(source, importer) {
        // useConnState.ts imports the bridge as "./bridge"; missing it leaves the real Tauri bridge
        // behind the TopBar chip, which then renders "disconnected" in every frame.
        if (importer?.includes("/packages/app/") && (/(?:^|\/)rpc\/bridge$/.test(source) || (source === "./bridge" && importer.includes("/src/rpc/")))) return "\0marketing-bridge";
        if (importer?.includes("/packages/app/") && /(?:^|\/)voice\/nativeCodex$/.test(source)) return "\0marketing-native-voice";
        if (importer?.includes("/packages/app/") && /(?:^|\/)native\/computerUse$/.test(source)) return "\0marketing-native-computer";
        if (source === "@tauri-apps/api/core" && importer?.endsWith("/src/components/ComputerUseCard.tsx")) return "\0marketing-tauri-core";
      },
      load(id) {
        if (id === "\0marketing-bridge") return `
          const call = (method, params = {}) => Promise.resolve().then(() => window.__MARKETING_RPC__?.(method, params));
          export const rpcCall = call;
          export const subscribeEvents = async () => {};
          export const onDaemonEvent = () => () => {};
          export const onDaemonState = (cb) => { cb("connected"); return () => {}; };
          export const daemonStatus = async () => "connected";
          export const readArtifactSnapshot = async () => null;
          export const openArtifactSnapshot = async () => {};
          export const openArtifactUrl = async () => {};
          export const setDockBadge = async () => {};
          export const exportCsv = async (filename) => "/mock/" + filename;
          export const checkpointFilesSince = async () => 0;
        `;
        if (id === "\0marketing-native-voice") return `
          const idle = { status: "idle", agentId: null, transcript: "", error: null };
          export const nativeCodexVoice = {
            subscribe() { return () => {}; },
            getState() { return idle; },
            getAgentState() { return idle; },
            getRooms() { return []; },
            join() {},
            stop() {},
            setFixtureActive() {},
          };
          export const createMeetingVoice = () => { throw new Error("not available in the marketing fixture"); };
          export const measureAudioLevel = () => () => {};
        `;
        if (id === "\0marketing-native-computer") return `
          export const computerUseNative = (command, args) => Promise.resolve().then(() => window.__MARKETING_COMPUTER__?.(command, args));
          export const computerUseAvailable = () => true;
        `;
        if (id === "\0marketing-tauri-core") return `
          export const isTauri = () => true;
          export const invoke = (command, args) => Promise.resolve().then(() => window.__MARKETING_COMPUTER__?.(command, args));
        `;
      },
      configureServer(server) {
        server.middlewares.use("/__marketing-video", (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'");
          res.end(SHELL);
        });
      },
    }],
  });
  await vite.listen();
  const address = vite.httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/__marketing-video`, port, close: async () => {
    try { await vite.close(); } finally {
      // Vite closes its listeners, but its esbuild service can keep this standalone capture process alive.
      esbuild.stop();
    }
  } };
}

/** Pins the page clock before any page script runs, so every timestamp a fixture mints and every
 * relative time the UI prints ("3m ago") is identical on every capture. */
export const FROZEN_CLOCK_SCRIPT = (isoInstant) => `(() => {
  const FIXED = Date.parse(${JSON.stringify(isoInstant)});
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
    static now() { return FIXED; }
  }
  window.Date = FrozenDate;
})();`;
