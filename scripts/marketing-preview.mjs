// Product screenshots for the README and the GitHub Pages launch page.
//
// Renders the REAL app components (TopBar, AgentsScreen, QueuesScreen, MemoryScreen, Footer) in
// local headless Chromium, on the real app store, seeded with the fictional "Atlas website" demo
// data from packages/app/test/fixtures/marketing-data.ts through a mocked RPC bridge. No daemon,
// provider, account, network or agent is involved, and nothing here is drawn or generated.
//
//   node scripts/marketing-preview.mjs --serve     # print a local preview URL and keep serving
//   node scripts/marketing-preview.mjs --capture   # write site/assets/*.png + provenance.{json,md}
//
// Options: --view=workspace|queue|memory|mcp-store|secrets|schedules (repeatable; with --capture
// only those PNGs are rewritten), --out=<dir> (default site/assets). Chromium comes from
// CHIMERA_TEST_CHROME or the gate's discovery; it is never downloaded. Harness plumbing is shared
// with scripts/browser-gate.mjs, which stays untouched. provenance.{json,md} always describe the
// full set, so they are rewritten only by a run without --view.
//
// Adding a screen: (1) mount it in packages/app/test/fixtures/marketing.tsx (`screens` + `tabs`
// maps; a Settings section goes in `settingsSections`); (2) add the data it loads to
// marketing-features.ts (feature screens) or marketing-data.ts (workspace), and handle EVERY RPC
// method it calls: marketing-features.ts answers first and returns MISS for anything else, then
// marketingRpc answers, and an unhandled method logs "marketingRpc miss <method>" and returns []
// (this script prints those, so an empty panel means a missing case); (3) add a VIEWS entry below
// with `file`, `title`, a DOM `ready` expression and optional click steps. Keep ALL data
// fictional (Atlas website, /demo/... paths, `.invalid` hosts, secret NAMES only, no real
// accounts, keys or hosts) and re-run with --capture on a clean committed tree so provenance.json
// records an honest sourceRevision.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  connectCdp,
  createScratchDirectory,
  installLoopbackGuard,
  launchChromium,
  removeScratchDirectory,
  terminateOwnedProcess,
} from "./browser-gate.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(new URL("../packages/app/package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const serveOnly = flag("serve");
const outDir = resolve(repoRoot, option("out")[0] ?? "site/assets");

const WIDTH = 1600;
const HEIGHT = 1000;
const OG = { width: 1200, height: 630 };

// What each screenshot proves is on screen; the capture waits for these markers instead of
// sleeping, so a blank panel fails loudly rather than being saved.
const VIEWS = {
  workspace: {
    file: "chimera-workspace.png",
    title: "Workspace: fleet sidebar and the conductor's conversation",
    ready: `document.querySelectorAll('[data-agent-row]').length >= 3 && document.body.innerText.includes('Three gates are tagged on the queue')`,
  },
  queue: {
    file: "chimera-queue.png",
    title: "Queue: dependency-ordered tasks with the task inspector",
    ready: `document.querySelectorAll('[data-queue-row]').length >= 2`,
    // atlas-docs sorts first and would open by default; pick the busy queue, then a blocked task.
    steps: [
      { click: '[data-queue-row="atlas-release"]', then: `document.querySelectorAll('[data-task-row]').length >= 10` },
      { click: '[data-task-row="6b83d0e4"]', then: `document.body.innerText.includes('Final visual regression pass')` },
    ],
  },
  memory: {
    file: "chimera-memory.png",
    title: "Memory: shared notes, folders, links and capacity",
    ready: `document.querySelectorAll('[data-memory-row]').length >= 12`,
    // Never click the row that is already selected: that toggles the detail pane closed (Collapse
    // fades it to opacity 0), which is how an earlier capture came out with an empty note pane.
    steps: [{ click: '[data-memory-row="m-0007"]', then: `document.querySelector('[data-memory-link]') !== null` }],
  },
  "mcp-store": {
    file: "chimera-mcp-store.png",
    title: "MCP store: built-in and external servers, trust levels, OAuth status and discovered tools",
    ready: `document.querySelectorAll('[data-mcp-store-row]').length >= 8`,
    steps: [{ click: '[data-mcp-store-expand="atlas-docs"]', then: `document.querySelector('[data-mcp-store-tool]') !== null` }],
  },
  secrets: {
    file: "chimera-secrets.png",
    title: "Secrets: named secrets with masked values and per-agent access grants",
    ready: `document.querySelectorAll('[data-secret-row]').length >= 5`,
    // One row only: opening the create form would show an input a real value could be typed into.
    steps: [{ click: '[data-secret-row="ATLAS_DESIGN_EXPORT_TOKEN"] summary', then: `document.querySelector('[data-secret-row="ATLAS_DESIGN_EXPORT_TOKEN"] details[open]') !== null` }],
  },
  schedules: {
    file: "chimera-schedules.png",
    title: "Schedules: cron and interval jobs, retry state, and the run history of one job",
    ready: `document.querySelectorAll('[data-job-row]').length >= 6`,
    steps: [{ click: '[data-job-row="atlas-a11y-sweep"]', then: `document.body.innerText.includes('schedule · atlas-a11y-sweep')` }],
  },
  teams: {
    file: "chimera-teams.png",
    title: "Teams: bound queue, members, role provenance badges, pinned vs inherited role settings and live workers",
    ready: `document.querySelectorAll('[data-team-agent]').length >= 3 && document.querySelector('[data-role-provenance]') !== null`,
    // No role is expanded: an open override editor is ~600px tall and pushes the live workers off screen.
    // The collapsed rows already carry the provenance badges and pinned/inherited chips; the roles view shows the editor.
  },
  projects: {
    file: "chimera-projects.png",
    title: "Projects: checkpoints and the per-project setup / conductor-account settings",
    ready: `document.querySelectorAll('[data-session-row]').length >= 5 && document.querySelectorAll('[data-project-checkpoint-row]').length >= 3 && document.querySelector('[data-project-file-row]') !== null`,
  },
  roles: {
    file: "chimera-roles.png",
    title: "Roles: role library beside team role bindings, with a binding's override editor showing pinned vs inherited",
    ready: `document.querySelectorAll('[data-role-row]').length >= 9`,
    steps: [{ click: '[data-role-row="atlas/builder"]', then: `document.querySelector('[data-role-binding-override-editor]') !== null` }],
  },
  "computer-use": {
    file: "chimera-computer-use.png",
    title: "Computer use (DEMO): the actual desktop-control monitor component showing a synthetic demo target, not a real desktop",
    ready: `document.querySelector('[data-computer-monitor] img[src^="data:"]') !== null && document.querySelectorAll('[aria-label="Recent desktop actions"] li').length >= 3`,
  },
};
const requested = option("view");
const viewNames = requested.length ? requested : Object.keys(VIEWS);
// Provenance and the social card describe the whole set, so a filtered run must not rewrite them.
const fullRun = requested.length === 0;
for (const name of viewNames) if (!VIEWS[name]) throw new Error(`Unknown --view=${name}; expected ${Object.keys(VIEWS).join("|")}`);

const git = (...gitArgs) => execFileSync("git", ["-C", repoRoot, ...gitArgs], { encoding: "utf8" }).trim();

const scratch = createScratchDirectory("chimera-marketing-");
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

let vite;
let chrome;
let cdp;
try {
  vite = await createServer({
    root: resolve(repoRoot, "packages/app"),
    configFile: false,
    cacheDir: join(scratch, "vite"),
    esbuild: { jsx: "automatic" },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "marketing-fixture",
      enforce: "pre",
      resolveId(source, importer) {
        // useConnState.ts imports the bridge as "./bridge"; missing it leaves the real Tauri bridge
        // behind the TopBar chip, which then renders "disconnected" in every screenshot.
        if (importer?.includes("/packages/app/") && (/(?:^|\/)rpc\/bridge$/.test(source) || (source === "./bridge" && importer.includes("/src/rpc/")))) return "\0marketing-bridge";
        if (importer?.includes("/packages/app/") && /(?:^|\/)voice\/nativeCodex$/.test(source)) return "\0marketing-native-voice";
        if (importer?.includes("/packages/app/") && /(?:^|\/)native\/computerUse$/.test(source)) return "\0marketing-native-computer";
        // Only the Settings card talks to Rust directly (`invoke`, gated on isTauri); every other
        // importer of the Tauri API keeps the real module, so nothing else changes behaviour.
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
        // Both seams reach the fixture-owned handler (marketing-features.ts); there is no Rust side.
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
        server.middlewares.use("/__marketing", (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'");
          res.end('<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Chimera marketing preview (demo data)</title></head><body><div id="root"></div><script type="module" src="/test/fixtures/marketing.tsx"></script></body></html>');
        });
      },
    }],
  });
  await vite.listen();
  const address = vite.httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}/__marketing`;

  if (serveOnly) {
    console.log(`Chimera marketing preview (fictional demo data, mocked RPC): ${url}`);
    console.log("Switch screens in the console with __MARKETING__.show('workspace' | 'queue' | 'memory' | 'mcp-store' | 'secrets' | 'schedules' | 'teams' | 'projects' | 'roles' | 'computer-use'), or open ?view=<name>. Ctrl-C to stop.");
    await new Promise((done) => controller.signal.addEventListener("abort", done, { once: true }));
  } else {
    const signal = controller.signal;
    const launched = await launchChromium({
      signal,
      args: [
        "--headless=new",
        "--mute-audio",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--remote-debugging-port=0",
        `--user-data-dir=${join(scratch, "chrome")}`,
        "about:blank",
      ],
    });
    chrome = launched.child;
    cdp = await connectCdp(launched.endpoint, { signal });
    const { call } = cdp;
    // A method the fixture does not answer returns [] and renders an empty panel; make it loud.
    const rpcMisses = new Set();
    cdp.onEvent((message) => {
      if (message.method === "Runtime.exceptionThrown") console.error("Browser exception:", JSON.stringify(message.params).slice(0, 600));
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "warning" && message.params.args?.[0]?.value === "marketingRpc miss") rpcMisses.add(String(message.params.args[1]?.value));
    });
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    await call("Page.enable", {}, sessionId);
    await call("Runtime.enable", {}, sessionId);
    await installLoopbackGuard(cdp, sessionId, `http://127.0.0.1:${port}`);

    const evaluate = async (expression) => {
      const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
      return result.result.value;
    };
    const waitFor = async (expression, label, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(`Boolean(${expression})`)) return;
        await new Promise((r) => setTimeout(r, 60));
      }
      // A blank or half-loaded panel is the failure this gate exists to catch; show what rendered.
      const shot = await call("Page.captureScreenshot", { format: "png" }, sessionId).catch(() => null);
      // Outside outDir on purpose: a failed run must never leave a half-rendered PNG in site/assets.
      const debugPath = join(tmpdir(), `chimera-marketing-debug-${label.replace(/\W+/g, "-")}.png`);
      if (shot) writeFileSync(debugPath, Buffer.from(shot.data, "base64"));
      const seen = await evaluate("JSON.stringify({agents: document.querySelectorAll('[data-agent-row]').length, tasks: document.querySelectorAll('[data-task-row]').length, memory: document.querySelectorAll('[data-memory-row]').length, mcp: document.querySelectorAll('[data-mcp-store-row]').length, jobs: document.querySelectorAll('[data-job-row]').length, secrets: document.querySelectorAll('[data-secret-row]').length, text: document.body.innerText.slice(0, 700)})").catch(() => "(page unreadable)");
      throw new Error(`Timed out waiting for ${label}: ${expression}\nRendered: ${seen}\nScreenshot of the stuck page: ${shot ? debugPath : "(unavailable)"}`);
    };
    const frames = () => evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const viewport = async (width, height) => {
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, sessionId);
      await waitFor(`innerWidth === ${width} && innerHeight === ${height}`, "viewport");
      await frames();
    };
    const click = async (selector) => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block: "nearest"})`);
      await frames();
      const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
      if (!point) throw new Error(`missing click target: ${selector}`);
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, sessionId);
      await call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
    };

    mkdirSync(outDir, { recursive: true });
    await viewport(WIDTH, HEIGHT);
    await call("Page.navigate", { url }, sessionId);
    await waitFor("window.__MARKETING__", "marketing fixture boot");
    const written = [];

    const open = async (name) => {
      const view = VIEWS[name];
      await evaluate(`window.__MARKETING__.show(${JSON.stringify(name)})`);
      await waitFor(`document.body.dataset.marketingReady === ${JSON.stringify(name)}`, `${name} mount`);
      await waitFor(view.ready, `${name} content`);
      for (const step of view.steps ?? []) {
        // Real pointer input on the real rows, so queue/inspector/detail panes render exactly as
        // they do for a user rather than through a state shortcut.
        await click(step.click);
        await waitFor(step.then, `${name} after clicking ${step.click}`);
      }
      await evaluate("document.fonts.ready.then(() => true)");
      await frames();
    };
    const shoot = async (file, clip) => {
      const capture = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, ...(clip ? { clip: { x: 0, y: 0, ...clip, scale: 1 } } : {}) }, sessionId);
      const path = join(outDir, file);
      writeFileSync(path, Buffer.from(capture.data, "base64"));
      written.push(path);
      console.log(`wrote ${relative(repoRoot, path)}`);
    };

    for (const name of viewNames) {
      await open(name);
      await shoot(VIEWS[name].file);
    }

    // The social card and provenance describe the whole set; a filtered run leaves them alone so it
    // can never publish a provenance file that omits images still on disk.
    if (fullRun) {
      // The social card is a real render at its own size, not a crop or a composite.
      await viewport(OG.width, OG.height);
      await open("workspace");
      await shoot("og-image.png");
      await viewport(WIDTH, HEIGHT);
    }
    if (rpcMisses.size) throw new Error(`Fixture RPC methods with no answer (they rendered empty panels): ${[...rpcMisses].join(", ")}`);

    if (fullRun) {
      const browser = await call("Browser.getVersion");
      const status = git("status", "--porcelain", "--", "packages/app", "packages/ui-state", "packages/protocol", "scripts/marketing-preview.mjs");
      const provenance = {
        kind: "demo-screenshots",
        notice: "Actual Chimera UI components rendered with fictional demo data. Not a live workspace, not a benchmark, not real user activity.",
        demoProject: "Atlas website (fictional)",
        capturedOn: new Date().toISOString().slice(0, 10),
        sourceRevision: git("rev-parse", "HEAD"),
        uncommittedProductChanges: status.length > 0,
        viewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 },
        browser: browser.product,
        rendering: "Real React components on the real app store in headless Chromium; mocked RPC bridge; loopback-only network guard; no daemon, provider, account, filesystem, desktop or agent involved.",
        components: [
          "TopBar", "AgentsScreen (AgentList, transcript)", "QueuesScreen (task list, TaskInspector, schedules panel and ScheduleDetail)",
          "MemoryScreen (FolderRail, note list, detail)", "SettingsScreen (MCP store section with ComputerUseCard, Secrets section)",
          "TeamsScreen (team detail, role provenance badges, RoleBindingOverrideEditor, AgentInspector)", "ProjectsScreen (project detail, sessions, checkpoints, FileTree, per-project settings)",
          "RolesScreen (role library, team role bindings, override editor)", "ComputerUseMonitor inside AgentsScreen's transcript panel (demo target)", "Footer",
        ],
        dataSource: "packages/app/test/fixtures/marketing-data.ts (workspace, queues, memory) and packages/app/test/fixtures/marketing-features.ts (MCP store, secrets, schedules, teams, roles, projects, computer-use demo)",
        timestamps: "Relative to capture time; paths use the fictional /demo/atlas-website.",
        fixtureNotes: "MCP servers are fictional entries on reserved .invalid hosts; secrets are names with masked state only, no values exist; no OAuth flow, tool call or schedule run is executed. Computer use is a DEMO: the monitor component is real, but its target image is a synthetic SVG drawn by the fixture (it carries a visible \"DEMO · synthetic target\" banner and a large DEMO watermark, so it cannot be mistaken for a real desktop) and the lease, actions and status are scripted — no desktop was captured or controlled, and no permission was requested. Projects, checkpoints, files, teams and role bindings are scripted fixture data; no git, filesystem or agent exists behind them.",
        reproduce: "node scripts/marketing-preview.mjs --capture",
        images: [
          ...Object.values(VIEWS).map((view) => ({ file: view.file, width: WIDTH, height: HEIGHT, shows: view.title })),
          { file: "og-image.png", width: OG.width, height: OG.height, shows: "Workspace view rendered at 1200x630 for social cards" },
        ],
      };
      writeFileSync(join(outDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
      const md = [
        "# Screenshot provenance",
        "",
        `> ${provenance.notice}`,
        "",
        `- Demo project: **${provenance.demoProject}** (every name, path, task, note, server and secret name is fictional)`,
        `- Captured: ${provenance.capturedOn} from source revision \`${provenance.sourceRevision}\`${provenance.uncommittedProductChanges ? " (uncommitted product changes present)" : ""}`,
        `- Viewport: ${WIDTH}x${HEIGHT} at device scale factor 1 (${provenance.browser}, headless)`,
        `- Rendering: ${provenance.rendering}`,
        `- Components: ${provenance.components.join("; ")}`,
        `- Demo data: ${provenance.dataSource}; ${provenance.timestamps}`,
        `- Fixture notes: ${provenance.fixtureNotes}`,
        `- Reproduce: \`${provenance.reproduce}\` (needs a local Chromium; set \`CHIMERA_TEST_CHROME\` to choose one)`,
        "",
        "| File | Size | Shows |",
        "| --- | --- | --- |",
        ...provenance.images.map((img) => `| \`${img.file}\` | ${img.width}x${img.height} | ${img.shows} |`),
        "",
      ].join("\n");
      writeFileSync(join(outDir, "provenance.md"), md);
      console.log(`wrote ${relative(repoRoot, join(outDir, "provenance.json"))} and provenance.md`);
    } else {
      console.log("Filtered run: provenance.{json,md} and og-image.png left untouched; run without --view to refresh them.");
    }
  }
} finally {
  try { cdp?.close(); } finally {
    try { await terminateOwnedProcess(chrome); } finally {
      try { await vite?.close(); } finally { await removeScratchDirectory(scratch); }
    }
  }
}
