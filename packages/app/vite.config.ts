import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);

// EXCALIDRAW-DIAGRAMS — serve @excalidraw/excalidraw's fonts from the app's OWN
// origin so a rendered diagram NEVER fetches from a remote CDN (the feature's
// no-network guardrail). ExcalidrawBlock.tsx sets window.EXCALIDRAW_ASSET_PATH
// = "/", so Excalidraw requests fonts at "/fonts/<Family>/<file>.woff2". This
// plugin serves that path from the package's dist/prod/fonts in dev, and copies
// the same tree into the build output. Fonts come from node_modules — they are
// NOT vendored into the repo.
function excalidrawAssets(): Plugin {
  // The package's exports map blocks ./package.json, so resolve the main entry
  // (dist/prod/index.js) and take its sibling fonts/ dir instead.
  const fontsDir = path.join(path.dirname(require.resolve("@excalidraw/excalidraw")), "fonts");
  let outDir = "dist";
  return {
    name: "excalidraw-assets",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith("/fonts/")) return next();
        // decodeURIComponent throws URIError on a malformed % escape — defer
        // like any other non-match rather than 500ing the request.
        let rel: string;
        try {
          rel = decodeURIComponent(url.slice("/fonts/".length));
        } catch {
          return next();
        }
        // guard against path traversal escaping the fonts dir (trailing sep so
        // a sibling like "fonts-x" can't prefix-match the "fonts" dir).
        const file = path.join(fontsDir, rel);
        if (!file.startsWith(fontsDir + path.sep)) return next();
        // must resolve to a real FILE — a directory (e.g. /fonts/Assistant, a
        // font family dir) would EISDIR the read stream and crash the dev
        // server, so defer instead. statSync throws on ENOENT → also defer.
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          return next();
        }
        if (!stat.isFile()) return next();
        res.setHeader("Content-Type", "font/woff2");
        // a late stream error (races a delete, perms) must not crash the server.
        fs.createReadStream(file)
          .on("error", () => { if (!res.headersSent) next(); })
          .pipe(res);
      });
    },
    closeBundle() {
      if (!fs.existsSync(fontsDir)) return;
      fs.cpSync(fontsDir, path.join(outDir, "fonts"), { recursive: true });
    },
  };
}

// Tauri expects a fixed dev-server port; strictPort fails fast instead of
// silently drifting to a port the webview isn't pointed at.
export default defineConfig({
  plugins: [react(), excalidrawAssets()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    rollupOptions: { input: { desktop: path.resolve(import.meta.dirname, "index.html"), operator: path.resolve(import.meta.dirname, "operator.html") } },
  },
});
