// Real Chromium rendering of actual app components through an isolated Vite
// fixture. Synthetic state only: no daemon, provider, account, network, mic or
// production build. Set CHIMERA_BROWSER_GATE_SCREENSHOTS=1 to capture screenshots.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  REQUIRED_CHECK_IDS,
  connectCdp,
  createScreenshotDirectory,
  createScratchDirectory,
  installLoopbackGuard,
  launchChromium,
  removeScratchDirectory,
  runBrowserSuiteCli,
  terminateOwnedProcess,
  verifyLoopbackGuard,
} from "./browser-gate.mjs";

const require = createRequire(new URL("../packages/app/package.json", import.meta.url));
const { createServer } = await import(pathToFileURL(require.resolve("vite")).href);

const suiteExitCode = await runBrowserSuiteCli("ui", async ({ reporter, signal }) => {
  const scratch = createScratchDirectory("chimera-ui-browser-");
  let artifactDir;
  const check = reporter.check.bind(reporter);
  let chrome;
  let cdp;
  let vite;
  let designLeaks = 0;
  try {
    artifactDir = createScreenshotDirectory("ui");
  vite = await createServer({
    root: resolve("packages/app"),
    configFile: false,
    cacheDir: join(scratch, "vite"),
    ...(process.env.CHIMERA_BROWSER_GATE_TEST_NO_OPTIMIZE === "1" ? { optimizeDeps: { noDiscovery: true, include: [] } } : {}),
    esbuild: { jsx: "automatic" },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "ui-regression-fixture",
      enforce: "pre",
      resolveId(source, importer) {
        if (importer?.includes("/packages/app/") && /(?:^|\/)rpc\/bridge$/.test(source)) return "\0ui-qa-bridge";
        if (importer?.includes("/packages/app/") && /(?:^|\/)voice\/nativeCodex$/.test(source)) return "\0ui-qa-native-voice";
        if (importer?.includes("/packages/app/") && /(?:^|\/)native\/computerUse$/.test(source)) return "\0ui-qa-native-computer";
      },
      load(id) {
        if (id === "\0ui-qa-bridge") return `
          const call = (method, params = {}) => Promise.resolve().then(() => window.__UI_QA_RPC__?.(method, params));
          export const rpcCall = call;
          export const subscribeEvents = async () => {};
          export const onDaemonEvent = () => () => {};
          export const onDaemonState = (cb) => { cb("connected"); return () => {}; };
          export const daemonStatus = async () => "connected";
          export const readArtifactSnapshot = async (id) => call("artifact.read", {id});
          export const openArtifactSnapshot = async () => {};
          export const openArtifactUrl = async () => {};
          export const setDockBadge = async () => {};
          export const exportCsv = async (filename) => "/mock/" + filename;
          export const checkpointFilesSince = async () => 0;
        `;
        if (id === "\0ui-qa-native-voice") return `
          const listeners = new Set();
          const idle = { status: "idle", agentId: null, transcript: "", error: null };
          const live = { status: "listening", agentId: "ui-qa-agent", transcript: "", error: null, inputLevel: 0.2, outputLevel: 0.4 };
          let view = idle;
          let rooms = [];
          const emit = () => listeners.forEach((listener) => listener());
          export const nativeCodexVoice = {
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            getState() { return view; },
            getAgentState(agentId) { return agentId === "ui-qa-agent" ? view : idle; },
            getRooms() { return rooms; },
            join() {},
            stop() { view = idle; rooms = []; emit(); },
            setFixtureActive(value) {
              view = value ? live : idle;
              rooms = value ? [{ ...live, roomId: "ui-qa-room", joined: true }] : [];
              emit();
            },
          };
          export const createMeetingVoice = () => { throw new Error("not available in the isolated UI fixture"); };
          export const measureAudioLevel = () => () => {};
        `;
        if (id === "\0ui-qa-native-computer") return `
          export const computerUseNative = (command, args) => Promise.resolve().then(() => window.__UI_QA_COMPUTER__?.(command, args));
          export const computerUseAvailable = () => true;
        `;
      },
      configureServer(server) {
        server.middlewares.use("/__design-leak", (_req, res) => { designLeaks++; res.end("blocked resource"); });
        server.middlewares.use("/__ui-qa", (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'");
          res.end('<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Chimera UI QA</title></head><body><div id="root"></div><script>window.__CHIMERA_MOCK__={rpc:async()=>({})}</script><script type="module" src="/test/fixtures/ui-browser.tsx"></script></body></html>');
        });
      },
    }],
  });
  await vite.listen();
  const address = vite.httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
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
  cdp.onEvent(message => { if (message.method === "Runtime.exceptionThrown") console.error("Browser exception:", JSON.stringify(message.params)); });
  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  await call("Page.enable", {}, sessionId);
  await call("Runtime.enable", {}, sessionId);
  await installLoopbackGuard(cdp, sessionId, `http://127.0.0.1:${port}`);
  await call("Page.navigate", { url: `http://127.0.0.1:${port}/__ui-qa` }, sessionId);
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  const viewport = async (width, height, reducedMotion = false) => {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" }] }, sessionId);
    await waitFor(`innerWidth === ${width} && innerHeight === ${height}`);
    await evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  };
  const screenshot = async (name) => {
    if (!artifactDir) return null;
    const capture = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    const path = join(artifactDir, `${name}.png`);
    writeFileSync(path, Buffer.from(capture.data, "base64"));
    return path;
  };
  const show = async (name) => {
    await evaluate(`window.__UI_QA__.show(${JSON.stringify(name)})`);
    await waitFor(`document.body.dataset.fixtureReady === ${JSON.stringify(name)}`);
  };
  const key = async (keyName, modifiers = 0) => {
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code: keyName, modifiers }, sessionId);
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code: keyName, modifiers }, sessionId);
  };
  const buttonKey = async (keyName, code) => {
    const keyCode = keyName === "Enter" ? 13 : 32;
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, text: keyName === "Enter" ? "\r" : " ", windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }, sessionId);
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }, sessionId);
  };
  const settleRender = () => evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const click = async (selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block: "nearest", inline: "nearest"})`);
    await settleRender();
    const point = await evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`);
    assert.ok(point, `missing click target: ${selector}`);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
  };
  const pointerPoint = async (selector) => {
    const point = await evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, outsideX: rect.right + 40 } : null;
    })()`);
    assert.ok(point, `missing pointer target: ${selector}`);
    return point;
  };
  const layoutAudit = async (scope = "document.body") => evaluate(`(() => {
    const root = ${scope};
    const rootRect = root.getBoundingClientRect();
    const bounds = root === document.body
      ? { left: 0, right: innerWidth }
      : { left: rootRect.left, right: rootRect.right };
    const all = [...root.querySelectorAll("*")];
    const overflowing = all.filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || el.closest('[aria-hidden="true"],[inert]')) return false;
      return s.position !== "fixed" && r.width > 0 && (r.right > bounds.right + 1 || r.left < bounds.left - 1);
    }).map((el) => ({ tag: el.tagName, text: (el.textContent || "").trim().slice(0, 40), rect: el.getBoundingClientRect().toJSON() })).slice(0, 8);
    const interactive = [...root.querySelectorAll('button,a[href],input,select,textarea,[role="button"],[role="tab"],[tabindex]')];
    const hiddenInteractive = interactive.filter((el) => {
      if (el.disabled || el.tabIndex < 0) return false;
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      // display:none/visibility:hidden/inert controls are removed from the
      // browser's tab sequence. Flag rendered zero-size controls and controls
      // hidden from assistive tech while still keyboard-reachable.
      if (s.display === "none" || s.visibility === "hidden" || el.closest("[inert]")) return false;
      return r.width === 0 || r.height === 0 || el.closest('[aria-hidden="true"]');
    }).map((el) => ({ tag: el.tagName, text: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40) }));
    return {
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      scopeWidth: rootRect.width,
      scopeScrollWidth: root.scrollWidth,
      overflowing,
      hiddenInteractive,
    };
  })()`);

  await waitFor("window.__UI_QA__");
  const networkGuard = await verifyLoopbackGuard(evaluate);
  check("network guard blocks external fetch and websocket", networkGuard.fetchBlocked && networkGuard.websocketBlocked
    && networkGuard.attempts.length === 2 && networkGuard.attempts.every((attempt) => attempt.blocked), networkGuard);

  await viewport(390, 900);
  await show("computer-use");
  await waitFor(`document.querySelector('[data-computer-use] [role="status"]')?.textContent === 'Permissions required'`);
  check("computer use identifies Chimera as permission owner", await evaluate(`document.querySelector('[data-computer-use]').textContent.includes('Permission owner: Chimera') && !document.querySelector('[data-computer-use]').textContent.includes('CuaDriver')`));
  check("computer use controls fit a 390px screen", await evaluate(`(() => { const card = document.querySelector('[data-computer-use]'); return card.scrollWidth <= card.clientWidth + 1 && [...card.querySelectorAll('button')].every(b => b.getBoundingClientRect().right <= 390); })()`));
  await waitFor(`document.querySelectorAll('[data-computer-use] [data-built-in]').length === 3`);
  check("computer use labels built-in integrations and first-use assets", await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-computer-use] [data-built-in]')];
    const laya = document.querySelector('[data-built-in="laya"]');
    return rows.every(li => li.querySelector('[data-built-in-badge]')?.textContent === 'Built-in')
      && laya.textContent.includes('Not installed') && laya.textContent.includes('download on first use')
      && !document.querySelector('[data-built-in="chimera-browser"]').textContent.includes('first use');
  })()`));
  check("computer use built-in rows fit a 390px screen", await evaluate(`[...document.querySelectorAll('[data-computer-use] [data-built-in]')].every(li => li.scrollWidth <= li.clientWidth + 1 && li.getBoundingClientRect().right <= 390)`));
  await evaluate(`([...document.querySelectorAll('[data-built-in="laya"] button')].find(b => b.textContent === 'Install Laya')).click()`);
  await waitFor(`document.querySelector('[data-built-in="laya"]')?.getAttribute('data-built-in-state') === 'installing'`);
  check("computer use installs Laya through the managed first-use download", await evaluate(`!document.querySelector('[data-built-in="laya"] button') && document.querySelector('[data-built-in="laya"]').textContent.includes('Downloading')`));
  await evaluate(`([...document.querySelectorAll('[data-computer-use] button')].find(b => b.textContent === 'Allow Chimera access')).click()`);
  await waitFor(`document.querySelector('[data-computer-use]').textContent.includes('fully quit and reopen Chimera')`);
  check("computer use permission flow explains app relaunch", true);
  await evaluate(`([...document.querySelectorAll('[data-computer-use] button')].find(b => b.textContent === 'Start desktop control')).click()`);
  await waitFor(`document.querySelector('[data-computer-use] [role="status"]')?.textContent === 'Running'`);
  await evaluate(`([...document.querySelectorAll('[data-computer-use] button')].find(b => b.textContent === 'Stop desktop control')).click()`);
  await waitFor(`document.querySelector('[data-computer-use] [role="status"]')?.textContent === 'Stopped'`);
  check("computer use starts and stops through native host controls", true);
  await viewport(1440, 1000);

  await viewport(1000, 760);
  await show("desktop-preview");
  // Every probe below drives the REAL TranscriptPanel + ComputerUseMonitor; only the daemon lease
  // (`mcpstore.monitor`) and the Rust commands are scripted through window.__UI_QA__.desktop.
  const deskCalls = () => evaluate(`window.__UI_QA__.desktop.calls().map((c) => c.command)`);
  const deskCount = async (command) => (await deskCalls()).filter((c) => c === command).length;
  // The monitor loop is status → lease read → (1s timer); two further status calls prove a full poll
  // ran against whatever the fixture changed just before this call.
  const deskPolls = async () => {
    const n = await deskCount("computer_use_status");
    await waitFor(`window.__UI_QA__.desktop.calls().filter((c) => c.command === "computer_use_status").length >= ${n + 2}`);
  };
  const overlay = `document.querySelector('[data-computer-monitor]')`;
  const overlayImg = `document.querySelector('[data-computer-monitor] img')`;
  const frameLabel = () => evaluate(`decodeURIComponent(${overlayImg}?.src ?? "")`);
  const actionTools = () => evaluate(`[...document.querySelectorAll('[data-computer-monitor] [aria-label="Recent desktop actions"] li')].map((li) => li.children[1].textContent)`);
  const noFrames = `![...document.images].some((img) => decodeURIComponent(img.src).includes("window"))`;

  await deskPolls();
  await evaluate(`window.__UI_QA__.desktop.lease("b", 22)`);
  await deskPolls();
  check("desktop preview stays out of other agent transcripts", await evaluate(`!${overlay} && !document.querySelector('[data-computer-monitor-reopen]')`) && await deskCount("computer_use_preview") === 0);

  await evaluate(`document.querySelector('[data-ui-qa-composer]').focus()`);
  await evaluate(`window.__UI_QA__.desktop.lease("a", 11)`);
  await waitFor(`${overlayImg}?.complete && ${overlayImg}.naturalWidth > 0`);
  // The overlay is anchored to the transcript BODY (below the agent header/stats), so placement is
  // measured against that scroll area, not the whole pane.
  const placement = await evaluate(`(() => {
    const o = ${overlay}.getBoundingClientRect();
    const pane = document.querySelector('[data-ui-qa-pane]');
    const p = pane.getBoundingClientRect();
    const body = pane.querySelector('[data-transcript-body]');
    const b = body.getBoundingClientRect();
    return { fromRight: b.right - o.right, fromTop: o.top - b.top, inPane: o.left >= p.left && o.right <= p.right && o.top >= p.top && o.bottom <= p.bottom,
      rightHalf: o.left + o.width / 2 > b.left + b.width / 2, overBody: ${overlay}.parentElement.contains(body) };
  })()`);
  check("desktop preview floats top-right inside the controlling transcript", placement.inPane && placement.rightHalf && placement.overBody && placement.fromRight >= 0 && placement.fromRight <= 24 && placement.fromTop >= 0 && placement.fromTop <= 16, placement);
  await screenshot("desktop-preview");

  const composer = await evaluate(`(() => {
    const c = document.querySelector('[data-ui-qa-composer]');
    const r = c.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { focused: document.activeElement === c, reachable: hit === c, clear: ${overlay}.getBoundingClientRect().bottom <= r.top };
  })()`);
  check("desktop preview does not steal focus or cover the composer", composer.focused && composer.reachable && composer.clear, composer);

  await viewport(390, 760);
  const narrow = await evaluate(`(() => {
    const o = ${overlay}.getBoundingClientRect();
    const body = document.querySelector('[data-ui-qa-pane] [data-transcript-body]').getBoundingClientRect();
    return { left: o.left, right: o.right, share: o.height / body.height, clipped: ${overlay}.scrollWidth > ${overlay}.clientWidth + 1,
      page: document.documentElement.scrollWidth, controls: [...${overlay}.querySelectorAll('button')].every((b) => b.getBoundingClientRect().right <= 390 && b.getBoundingClientRect().left >= 0) };
  })()`);
  await screenshot("desktop-preview-390");
  check("desktop preview fits a 390px transcript", narrow.left >= 0 && narrow.right <= 390 && !narrow.clipped && narrow.page <= 390 && narrow.controls && narrow.share <= 0.5, narrow);
  await viewport(1000, 760);

  await click('[aria-label="Collapse desktop preview"]');
  await waitFor(`!${overlayImg} && document.querySelector('[aria-label="Expand desktop preview"]')?.getAttribute('aria-expanded') === 'false'`);
  await deskPolls();
  const collapsedAt = await deskCount("computer_use_preview");
  await deskPolls();
  const pausedCollapsed = await deskCount("computer_use_preview") === collapsedAt;
  await click('[aria-label="Hide desktop preview"]');
  await waitFor(`!${overlay} && document.querySelector('[data-computer-monitor-reopen]')`);
  await deskPolls();
  const hiddenAt = await deskCount("computer_use_preview");
  await deskPolls();
  const pausedHidden = await deskCount("computer_use_preview") === hiddenAt;
  await click('[data-computer-monitor-reopen]');
  await waitFor(`${overlayImg}?.complete`);
  check("desktop preview collapse pauses frames and hide keeps control running", pausedCollapsed && pausedHidden && await deskCount("computer_use_stop") === 0
    && await evaluate(`document.activeElement?.getAttribute('aria-label') === 'Collapse desktop preview'`));

  await evaluate(`window.__UI_QA__.desktop.set({ defer: true })`);
  await waitFor(`window.__UI_QA__.desktop.pending().includes(11)`);
  await click('[data-select-agent="b"]');
  await evaluate(`window.__UI_QA__.desktop.lease("b", 22)`);
  await waitFor(`window.__UI_QA__.desktop.pending().includes(22) && ${overlay}`);
  await evaluate(`window.__UI_QA__.desktop.settle(11)`);
  await deskPolls();
  const afterLateA = await evaluate(`${noFrames}`);
  await evaluate(`window.__UI_QA__.desktop.settle(22)`);
  await waitFor(`${overlayImg}?.complete`);
  check("desktop preview drops a late frame after the agent switches", afterLateA && (await frameLabel()).includes("window 22") && !(await frameLabel()).includes("window 11"), await frameLabel());
  await evaluate(`window.__UI_QA__.desktop.set({ defer: false })`);

  const forB = await actionTools();
  await click('[data-select-agent="a"]');
  await evaluate(`window.__UI_QA__.desktop.lease("a", 11)`);
  await waitFor(`${overlayImg}?.complete && document.querySelector('[data-computer-monitor] [aria-label="Recent desktop actions"] li')`);
  const forA = await actionTools();
  check("desktop preview shows only the controlling agent actions", forB.join() === "type_text" && forA.sort().join() === "click,screenshot", { forA, forB });

  await evaluate(`window.__UI_QA__.desktop.set({ previewFails: true })`);
  await waitFor(`!${overlayImg} && ${overlay}.textContent.includes('Target window is unavailable')`);
  await evaluate(`window.__UI_QA__.desktop.set({ previewFails: false })`);
  await waitFor(`${overlayImg}?.complete`);
  await evaluate(`window.__UI_QA__.desktop.lease(null)`);
  await waitFor(`!${overlay} && !document.querySelector('[data-computer-monitor-reopen]') && ${noFrames}`);
  check("desktop preview clears on capture failure and lease release", await deskCount("computer_use_stop") === 0);

  await evaluate(`window.__UI_QA__.desktop.lease("a", 11)`);
  await waitFor(`${overlayImg}?.complete`);
  await click('[data-computer-monitor-stop]');
  await waitFor(`!${overlay}`);
  const stopped = await deskCount("computer_use_stop");
  await deskPolls();
  check("desktop preview stop calls the explicit stop service", stopped === 1 && await deskCount("computer_use_stop") === 1 && !(await evaluate(`${overlay}`)));

  const commands = [...new Set(await deskCalls())].sort();
  check("desktop preview never opens a native window", commands.every((c) => ["computer_use_preview", "computer_use_status", "computer_use_stop"].includes(c)), commands);
  await viewport(1440, 1000);

  const actionCounts = () => evaluate(`JSON.parse(document.querySelector('[data-ui-qa-action-counts]').textContent)`);
  const focus = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
  const input = (selector, value) => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await viewport(630, 760);

  await show("settings");
  await waitFor(`document.querySelector('[data-add-custom-provider]')`);
  await evaluate(`document.querySelector('[data-add-custom-provider]').click()`);
  await waitFor(`document.querySelector('[data-custom-provider-form]')`);
  await input('[data-custom-provider-id]', 'openai');
  await input('[data-custom-provider-label]', 'Collision');
  await input('[data-custom-provider-url]', 'http://127.0.0.1:1234/v1');
  await input('[data-custom-provider-model]', 'collision-model');
  const callsBeforeCollision = await evaluate('window.__UI_QA__.customProviderRpc().length');
  await click('[data-custom-provider-save]');
  await waitFor(`document.querySelector('[data-custom-provider-error]')`);
  const collision = await evaluate(`({ error: document.querySelector('[data-custom-provider-error]').textContent, calls: window.__UI_QA__.customProviderRpc().length })`);
  check("custom provider built-in id collision is visible without mutation", collision.error.includes("already exists") && collision.calls === callsBeforeCollision, collision);

  await input('[data-custom-provider-id]', 'local-lab');
  await input('[data-custom-provider-label]', 'Local Lab');
  await input('[data-custom-provider-url]', 'http://127.0.0.1:12434/openai/v1/');
  await input('[data-custom-provider-model]', 'fallback-chat');
  await click('[data-custom-provider-save]');
  await waitFor(`document.querySelector('[data-provider-catalog-card="local-lab"]')`);
  const noKey = await evaluate(`(() => {
    const calls = window.__UI_QA__.customProviderRpc();
    const add = calls.findIndex((call) => call.method === 'providers.addCustom' && call.params.id === 'local-lab');
    const later = calls.slice(add + 1);
    return { add, methods: later.map((call) => call.method), addParams: calls[add]?.params,
      card: document.querySelector('[data-provider-catalog-card="local-lab"]')?.textContent };
  })()`);
  const firstRefresh = noKey.methods.indexOf('providers.list');
  const modelRefresh = noKey.methods.indexOf('providers.models');
  check("custom provider no-key save preserves RPC order without secret write",
    noKey.add >= 0 && firstRefresh >= 0 && modelRefresh > firstRefresh && !noKey.methods.includes('accounts.setKey') && noKey.addParams.requiresKey === false,
    noKey);
  check("custom provider appears immediately after save", noKey.card.includes("Local Lab") && noKey.card.includes("http://127.0.0.1:12434/openai/v1"), noKey);
  check("custom provider model refresh is requested", await evaluate(`window.__UI_QA__.customProviderRpc().some((call) => call.method === 'providers.models' && call.params.provider === 'local-lab' && call.params.refresh === true)`));

  await show("spawn");
  await waitFor(`document.querySelector('[data-spawn-field="account"] option[value="local-lab"]')`);
  await evaluate(`(() => { const select = document.querySelector('[data-spawn-field="account"]'); select.value = 'local-lab'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`document.querySelector('[data-spawn-field="model"] option[value="discovered-chat"]')`);
  const discovered = await evaluate(`(() => { const model = document.querySelector('[data-spawn-field="model"]'); model.value = 'discovered-chat'; model.dispatchEvent(new Event('change', { bubbles: true })); return { options: [...model.options].map((o) => o.value), value: model.value }; })()`);
  check("custom provider discovered model is selectable in spawn UI", discovered.options.includes("discovered-chat") && discovered.value === "discovered-chat", discovered);

  await show("settings");
  await waitFor(`document.querySelector('[data-add-custom-provider]')`);
  await evaluate(`document.querySelector('[data-add-custom-provider]').click()`);
  await waitFor(`document.querySelector('[data-custom-provider-form]')`);
  await input('[data-custom-provider-id]', 'keyed-lab');
  await input('[data-custom-provider-label]', 'Keyed Lab');
  await input('[data-custom-provider-url]', 'https://keyed.example.test:9443/v1');
  await input('[data-custom-provider-model]', 'secure-chat');
  await evaluate(`document.querySelector('[data-custom-provider-requires-key]').click()`);
  await waitFor(`document.querySelector('[data-custom-provider-key][type="password"]')`);
  await focus('[data-custom-provider-key]');
  await call("Input.insertText", { text: "browser-fixture-secret" }, sessionId);
  const passwordType = await evaluate(`document.querySelector('[data-custom-provider-key]').type`);
  await evaluate(`document.querySelector('[data-custom-provider-save]').click()`);
  await waitFor(`document.querySelector('[data-provider-catalog-card="keyed-lab"]')`);
  const keyed = await evaluate(`(() => { const calls = window.__UI_QA__.customProviderRpc(); const add = calls.findIndex((call) => call.method === 'providers.addCustom' && call.params.id === 'keyed-lab'); const setKey = calls.findIndex((call, i) => i > add && call.method === 'accounts.setKey' && call.params.name === 'keyed-lab'); return { add, setKey, passwordStillRendered: document.body.textContent.includes('browser-fixture-secret') }; })()`);
  check("custom provider keyed path uses write-only password field", passwordType === "password" && keyed.add >= 0 && keyed.setKey > keyed.add && !keyed.passwordStillRendered, keyed);
  await show("confirm-actions");
  await waitFor(`document.querySelector('[data-confirm]')`);
  const confirmButtons = await evaluate(`([...document.querySelectorAll('[data-confirm], [data-confirm-cancel]')].map((button) => ({
    tag: button.tagName, type: button.getAttribute('type'), name: button.textContent.trim(), tabIndex: button.tabIndex,
  })))`);
  check("chip actions render named native confirm buttons", confirmButtons.length === 2
    && confirmButtons.every((button) => button.tag === "BUTTON" && button.type === "button" && button.tabIndex === 0)
    && confirmButtons.some((button) => button.name.includes("confirm action"))
    && confirmButtons.some((button) => button.name.includes("esc back")), confirmButtons);
  await focus("[data-confirm-editable]");
  await buttonKey("Enter", "Enter");
  check("editable ConfirmCard children do not confirm", (await actionCounts()).confirm === 0, await actionCounts());
  await focus("[data-confirm]");
  await buttonKey("Enter", "Enter");
  await settleRender();
  check("focused Confirm Enter confirms exactly once", (await actionCounts()).confirm === 1, await actionCounts());

  await show("confirm-actions");
  await waitFor(`document.querySelector('[data-confirm-cancel]')`);
  await focus("[data-confirm-cancel]");
  await buttonKey(" ", "Space");
  await settleRender();
  const confirmCancel = await actionCounts();
  check("focused Confirm Cancel Space only cancels once", confirmCancel.close === 1 && confirmCancel.confirm === 0, confirmCancel);

  await show("confirm-actions");
  await waitFor(`document.querySelector('[data-confirm-cancel]')`);
  await focus("[data-confirm-cancel]");
  await buttonKey("Enter", "Enter");
  await settleRender();
  const confirmCancelEnter = await actionCounts();
  check("focused Confirm Cancel Enter only cancels once", confirmCancelEnter.close === 1 && confirmCancelEnter.confirm === 0, confirmCancelEnter);

  await show("team-actions");
  await waitFor(`document.querySelector('[data-team-submit]')`);
  const teamButtons = await evaluate(`([...document.querySelectorAll('[data-team-submit], [data-team-cancel]')].map((button) => ({
    tag: button.tagName, type: button.getAttribute('type'), name: button.textContent.trim(), tabIndex: button.tabIndex,
  })))`);
  check("chip actions render named native team buttons", teamButtons.length === 2
    && teamButtons.every((button) => button.tag === "BUTTON" && button.type === "button" && button.tabIndex === 0)
    && teamButtons.some((button) => button.name.includes("save"))
    && teamButtons.some((button) => button.name.includes("esc cancel")), teamButtons);
  await focus('[data-field="instructions"]');
  await evaluate("new Promise((resolve) => requestAnimationFrame(resolve))");
  await focus("[data-team-submit]");
  await buttonKey("Enter", "Enter");
  await settleRender();
  const teamSave = await actionCounts();
  check("focused Team Save Enter submits once", teamSave.submit === 1, teamSave);
  await evaluate(`document.querySelector('[data-ui-qa-disabled-action]').click()`);
  await settleRender();
  check("disabled ChipButton cannot invoke its callback", (await actionCounts()).disabled === 0, await actionCounts());

  await show("team-actions");
  await waitFor(`document.querySelector('[data-team-cancel]')`);
  await focus("[data-team-cancel]");
  await buttonKey(" ", "Space");
  await settleRender();
  const teamCancel = await actionCounts();
  check("focused Team Cancel Space only cancels once", teamCancel.close === 1 && teamCancel.submit === 0, teamCancel);

  await show("team-actions");
  await waitFor(`document.querySelector('[data-team-cancel]')`);
  await focus("[data-team-cancel]");
  await buttonKey("Enter", "Enter");
  await settleRender();
  const teamCancelEnter = await actionCounts();
  check("focused Team Cancel Enter only cancels once", teamCancelEnter.close === 1 && teamCancelEnter.submit === 0, teamCancelEnter);

  await show("queue-actions");
  await waitFor(`document.querySelector('[data-queue-submit]')`);
  const queueButtons = await evaluate(`([...document.querySelectorAll('[data-queue-submit], [data-queue-cancel]')].map((button) => ({
    tag: button.tagName, type: button.getAttribute('type'), name: button.textContent.trim(), tabIndex: button.tabIndex,
  })))`);
  check("chip actions render named native queue buttons", queueButtons.length === 2
    && queueButtons.every((button) => button.tag === "BUTTON" && button.type === "button" && button.tabIndex === 0)
    && queueButtons.some((button) => button.name.includes("save"))
    && queueButtons.some((button) => button.name.includes("esc cancel")), queueButtons);
  await focus('[data-field="retryLimit"]');
  await buttonKey("Enter", "Enter");
  check("Queue input Enter still submits", (await actionCounts()).submit === 1, await actionCounts());

  await show("queue-actions");
  await waitFor(`document.querySelector('[data-queue-submit]')`);
  await focus('[data-field="retryLimit"]');
  await evaluate("new Promise((resolve) => requestAnimationFrame(resolve))");
  await focus("[data-queue-submit]");
  await buttonKey(" ", "Space");
  await settleRender();
  const queueSave = await actionCounts();
  check("focused Queue Save Space submits once", queueSave.submit === 1, queueSave);

  await show("queue-actions");
  await waitFor(`document.querySelector('[data-queue-cancel]')`);
  await focus("[data-queue-cancel]");
  await buttonKey("Enter", "Enter");
  await settleRender();
  const queueCancel = await actionCounts();
  check("focused Queue Cancel Enter only cancels once", queueCancel.close === 1 && queueCancel.submit === 0, queueCancel);

  await viewport(390, 760);
  await show("team-actions");
  await waitFor(`document.querySelector('[data-team-submit]')`);
  const narrowActionLayout = await layoutAudit(`document.querySelector('[data-ui-qa-action-host]')`);
  const narrowActionButtons = await evaluate(`(() => {
    const host = document.querySelector('[data-ui-qa-action-host]').getBoundingClientRect();
    return [...document.querySelectorAll('[data-team-submit], [data-team-cancel]')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { text: button.textContent.trim(), visible: rect.width > 0 && rect.height > 0 && rect.left >= host.left && rect.right <= host.right && rect.top >= host.top && rect.bottom <= host.bottom };
    });
  })()`);
  check("OverlayCard fits a 390px action-card host without cropped actions", narrowActionLayout.overflowing.length === 0
    && narrowActionLayout.scopeScrollWidth <= narrowActionLayout.scopeWidth + 1 && narrowActionButtons.every((button) => button.visible), { narrowActionLayout, narrowActionButtons });
  await screenshot("chip-actions-390");

  await viewport(630, 760);
  await show("team-actions");
  await waitFor(`document.querySelector('[data-team-submit]')`);
  const constrainedActionLayout = await layoutAudit(`document.querySelector('[data-ui-qa-action-host]')`);
  check("OverlayCard fits a constrained 630px pane", constrainedActionLayout.overflowing.length === 0
    && constrainedActionLayout.scopeScrollWidth <= constrainedActionLayout.scopeWidth + 1, constrainedActionLayout);

  await viewport(780, 760);
  await show("ptt");
  await waitFor(`document.querySelector('[data-push-to-talk]')`);
  await evaluate(`document.querySelector('[data-push-to-talk]').focus()`);
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" }, sessionId);
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", autoRepeat: true }, sessionId);
  await waitFor(`document.querySelector('[data-push-to-talk]')?.dataset.voiceStatus === 'listening'`, 1_000);
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space" }, sessionId);
  await waitFor(`window.__UI_QA__.pttSnapshot().sends.length === 1`, 1_000);
  const focusedPtt = await evaluate(`window.__UI_QA__.pttSnapshot()`);
  check("focused PTT Space hold starts and sends exactly once", focusedPtt.starts === 1 && focusedPtt.stops === 1 && focusedPtt.sends.length === 1, focusedPtt);
  check("focused PTT Space repeat does not scroll", await evaluate(`document.scrollingElement.scrollTop === 0`));

  await evaluate(`document.querySelector('[data-push-to-talk]').click()`);
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space" }, sessionId);
  check("focused PTT ignores the Space compatibility click and unowned keyup", await evaluate(`window.__UI_QA__.pttSnapshot().sends.length === 1`));

  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" }, sessionId);
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", autoRepeat: true }, sessionId);
  await waitFor(`document.querySelector('[data-push-to-talk]')?.dataset.voiceStatus === 'listening'`);
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" }, sessionId);
  await waitFor(`window.__UI_QA__.pttSnapshot().sends.length === 2`);
  await evaluate(`document.querySelector('[data-push-to-talk]').click()`);
  const enteredPtt = await evaluate(`window.__UI_QA__.pttSnapshot()`);
  check("focused PTT Enter hold starts and sends exactly once", enteredPtt.starts === 2 && enteredPtt.stops === 2 && enteredPtt.sends.length === 2, enteredPtt);
  check("focused PTT owns Enter before the root keymap", enteredPtt.backgroundActions === 0, enteredPtt);

  const pttPoint = await pointerPoint('[data-push-to-talk]');
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: pttPoint.x, y: pttPoint.y, button: "left", clickCount: 1 }, sessionId);
  await waitFor(`document.querySelector('[data-push-to-talk]')?.dataset.voiceStatus === 'listening'`);
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: pttPoint.x, y: pttPoint.y, button: "left", clickCount: 1 }, sessionId);
  await waitFor(`window.__UI_QA__.pttSnapshot().sends.length === 3`);
  const pointerPtt = await evaluate(`window.__UI_QA__.pttSnapshot()`);
  check("focused PTT primary pointer sends once despite its compatibility click", pointerPtt.starts === 3 && pointerPtt.stops === 3 && pointerPtt.sends.length === 3, pointerPtt);

  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: pttPoint.x, y: pttPoint.y, button: "right", clickCount: 1 }, sessionId);
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: pttPoint.x, y: pttPoint.y, button: "right", clickCount: 1 }, sessionId);
  check("focused PTT ignores right click", await evaluate(`window.__UI_QA__.pttSnapshot().starts === 3`));

  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: pttPoint.x, y: pttPoint.y, button: "left", clickCount: 1 }, sessionId);
  await waitFor(`document.querySelector('[data-push-to-talk]')?.dataset.voiceStatus === 'listening'`);
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: pttPoint.outsideX, y: pttPoint.y, button: "left", clickCount: 1 }, sessionId);
  await waitFor(`document.querySelector('[data-push-to-talk]')?.dataset.voiceStatus === 'idle'`);
  const outsidePtt = await evaluate(`window.__UI_QA__.pttSnapshot()`);
  check("focused PTT release outside cancels without sending", outsidePtt.starts === 4 && outsidePtt.stops === 4 && outsidePtt.sends.length === 3, outsidePtt);

  await evaluate(`window.__UI_QA__.pttSpeak()`);
  await waitFor(`document.querySelector('[data-push-to-talk]')?.dataset.voiceStatus === 'speaking'`);
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" }, sessionId);
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", autoRepeat: true }, sessionId);
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space" }, sessionId);
  await waitFor(`document.querySelector('[data-push-to-talk]')?.dataset.voiceStatus === 'idle'`);
  const stoppedPtt = await evaluate(`window.__UI_QA__.pttSnapshot()`);
  check("focused PTT stop-speaking key acts once and never records on release", stoppedPtt.starts === 4 && stoppedPtt.sends.length === 3, stoppedPtt);
  check("focused PTT title explains Space and Enter hold semantics", await evaluate(`document.querySelector('[data-push-to-talk]').title.includes('hold Space or Enter')`));

  await viewport(1500, 900);
  await show("topbar");
  await waitFor('document.querySelector("[data-topbar-nav]")');
  const wideTopbar = await evaluate(`(() => {
    const nav = document.querySelector("[data-topbar-nav]");
    const labels = [...nav.querySelectorAll(":scope > div:first-child > *")].map((el) => (el.textContent || "").trim());
    const buttons = [...nav.querySelectorAll("button[data-topbar-tab]")];
    return { labels, buttonCount: buttons.length, unique: new Set(labels).size };
  })()`);
  check("topbar wide labels are unique", wideTopbar.unique === wideTopbar.labels.length, wideTopbar);
  check("topbar tabs use keyboard-operable buttons", wideTopbar.buttonCount === wideTopbar.labels.length, wideTopbar);
  check("topbar wide layout has no page overflow", (await layoutAudit()).pageWidth <= 1500, await layoutAudit());
  await screenshot("topbar-wide");
  check("topbar account and spend controls are named native buttons", await evaluate(`document.querySelector('button[data-accounts-chip]')?.getAttribute('aria-label') === 'Accounts and peers' && document.querySelector('button[data-spend-chip]')?.getAttribute('aria-label') === 'Usage and cost'`));
  await evaluate(`document.querySelector('[data-accounts-chip]').focus()`);
  await buttonKey("Enter", "Enter");
  await waitFor(`document.querySelector('[data-accounts-rows]')`);
  check("topbar keyboard opens configured account details", await evaluate(`document.querySelector('[data-accounts-rows]').textContent.includes('synthetic-codex')`));
  await evaluate(`document.querySelector('[data-accounts-chip]').click()`);
  await waitFor(`!document.querySelector('[data-accounts-rows]')`);


  await viewport(760, 760);
  await waitFor('document.querySelector("[data-tab-overflow]")');
  await evaluate('document.querySelector("[data-tab-overflow]").click()');
  await waitFor('document.querySelector("[data-tab-overflow-popup]")');
  const narrowTopbar = await evaluate(`(() => {
    const popup = document.querySelector("[data-tab-overflow-popup]");
    const button = document.querySelector("[data-tab-overflow]");
    const rect = popup.getBoundingClientRect();
    const names = [...document.querySelectorAll("[data-topbar-tab],[data-topbar-overflow-tab]")].map((el) => (el.textContent || "").trim());
    return { rect: rect.toJSON(), expanded: button.getAttribute("aria-expanded"), names, unique: new Set(names).size };
  })()`);
  check("topbar overflow popup stays in viewport", narrowTopbar.rect.left >= 0 && narrowTopbar.rect.right <= 760 && narrowTopbar.rect.bottom <= 760, narrowTopbar);
  check("topbar overflow exposes expanded state", narrowTopbar.expanded === "true", narrowTopbar);
  check("topbar has no duplicate accessible controls", narrowTopbar.unique === narrowTopbar.names.length, narrowTopbar);
  const narrowTopbarLayout = await layoutAudit('document.querySelector("[data-topbar-bar]")');
  check("topbar narrow layout has no overflow", narrowTopbarLayout.overflowing.length === 0 && narrowTopbarLayout.pageWidth <= 760, narrowTopbarLayout);
  check("topbar has no hidden focusable controls", narrowTopbarLayout.hiddenInteractive.length === 0, narrowTopbarLayout);
  await screenshot("topbar-narrow");

  await viewport(1180, 760);
  await show("modal");
  await evaluate(`document.querySelector("[data-modal-opener]").focus(); document.querySelector("[data-modal-opener]").click()`);
  await waitFor('document.querySelector("[data-modal-first]")');
  const modalOpen = await evaluate(`({
    dialog: Boolean(document.querySelector('[role="dialog"]:not([aria-modal="true"])')),
    active: document.activeElement?.getAttribute("data-modal-first") !== null,
  })`);
  check("overlay exposes non-modal dialog semantics", modalOpen.dialog, modalOpen);
  const accessibility = await call("Accessibility.getFullAXTree", {}, sessionId);
  check("overlay is named by its real title", accessibility.nodes.some((node) => node.role?.value === "dialog" && node.name?.value === "UI regression dialog"));
  await click('[data-topbar-tab="teams"]');
  check("real topbar navigation click works while card stays open", await evaluate(`document.querySelector('[data-topbar-tab="teams"]')?.getAttribute('aria-current') === 'page' && Boolean(document.querySelector('[data-modal-first]'))`));
  await screenshot("overlay-open-nonmodal");
  check("overlay preserves child autofocus and skips hidden controls", modalOpen.active, modalOpen);
  await evaluate('document.querySelector("[data-modal-last]").focus()');
  await key("Tab");
  await key("Tab");
  check("non-modal overlay lets Tab reach the top bar", await evaluate('document.activeElement?.getAttribute("data-topbar-tab") !== null'), await evaluate('document.activeElement?.outerHTML'));
  await evaluate('document.querySelector("[data-modal-first]").focus()');
  await key("Tab", 8);
  await key("Tab", 8);
  await key("Tab", 8);
  check("non-modal overlay lets Shift+Tab reach agent switching", await evaluate('document.activeElement?.getAttribute("data-agent-switch") !== null'), await evaluate('document.activeElement?.outerHTML'));
  await click("[data-agent-switch]");
  check("pane-confined scrim leaves agent switching clickable", await evaluate('document.querySelector("[data-agent-switch]")?.textContent?.includes("1") && Boolean(document.querySelector("[data-modal-first]"))'));
  await evaluate('document.querySelector("[data-modal-nested-opener]").focus(); document.querySelector("[data-modal-nested-opener]").click()');
  await waitFor('document.querySelectorAll(\'[role="dialog"]\').length === 2');
  check("portaled nested dialog owns initial focus", await evaluate('document.activeElement?.getAttribute("data-modal-nested-first") !== null'), await evaluate('document.activeElement?.outerHTML'));
  await evaluate('document.querySelector("[data-modal-nested-last]").focus()');
  await key("Tab");
  check("portaled nested dialog remains non-modal", await evaluate('document.activeElement?.getAttribute("data-topbar-tab") !== null'), await evaluate('document.activeElement?.outerHTML'));
  await evaluate('document.querySelector("[data-modal-nested-last]").focus()');
  await key("Escape");
  await waitFor('document.querySelectorAll(\'[role="dialog"]\').length === 1');
  check("nested Escape leaves the parent dialog open", await evaluate('Boolean(document.querySelector("[data-modal-first]"))'));
  await waitFor('document.activeElement?.getAttribute("data-modal-nested-opener") !== null');
  check("nested dialog restores its live opener", await evaluate('document.activeElement?.getAttribute("data-modal-nested-opener") !== null'), await evaluate('document.activeElement?.outerHTML'));
  await key("Escape");
  await waitFor('!document.querySelector("[data-modal-first]")');
  await waitFor('document.activeElement?.getAttribute("data-modal-opener") !== null');
  check("overlay restores opener focus", await evaluate('document.activeElement?.getAttribute("data-modal-opener") !== null'), await evaluate('document.activeElement?.outerHTML'));

  await show("modal");
  await evaluate(`document.querySelector("[data-modal-opener]").focus(); document.querySelector("[data-modal-opener]").click()`);
  await waitFor('document.querySelector("[data-modal-first]")');
  await click("[data-agent-switch]");
  await key("Escape");
  await waitFor('!document.querySelector("[data-modal-first]")');
  check("closing after agent switching preserves external focus", await evaluate('document.activeElement?.getAttribute("data-agent-switch") !== null'), await evaluate('document.activeElement?.outerHTML'));

  await show("modal");
  await evaluate(`document.querySelector("[data-modal-opener]").focus(); document.querySelector("[data-modal-opener]").click()`);
  await waitFor('document.querySelector("[data-modal-first]")');
  await evaluate('document.querySelector("[data-modal-opener]").hidden = true');
  await key("Escape");
  await waitFor('!document.querySelector("[data-modal-first]")');
  check("overlay does not restore focus to a hidden opener", await evaluate('document.activeElement?.getAttribute("data-modal-opener") === null'));

  await show("modal");
  await evaluate(`document.querySelector("[data-modal-opener]").focus(); document.querySelector("[data-modal-opener]").click()`);
  await waitFor('document.querySelector("[data-modal-first]")');
  await evaluate('document.querySelector("[data-modal-opener]").remove()');
  await key("Escape");
  await waitFor('!document.querySelector("[data-modal-first]")');
  check("overlay does not restore focus to a disconnected opener", await evaluate('!document.querySelector("[data-modal-opener]")'));
  await screenshot("modal-closed");

  for (const mode of ["external-focus", "cancel-focus", "inline-child", "portal-child", "no-close", "guard-popup"]) {
    await show(mode);
    await click("[data-edge-opener]");
    if (mode === "external-focus") check("initial focus preserves deliberate external focus before microtask", await evaluate('document.activeElement?.hasAttribute("data-edge-outside")'));
    if (mode === "cancel-focus") check("cancel before initial focus microtask restores opener without detached focus", await evaluate(`!document.querySelector('[role="dialog"]') && document.activeElement?.hasAttribute("data-edge-opener")`));
    if (mode === "inline-child" || mode === "portal-child") check(`${mode} keeps child autofocus on simultaneous mount`, await evaluate('document.activeElement?.hasAttribute("data-edge-child")'));
    if (mode === "no-close") {
      await evaluate('window.__escapeSeen = 0; document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.defaultPrevented) window.__escapeSeen++; }, { once: true })');
      await key("Escape");
      check("card without onClose does not swallow Escape", await evaluate('window.__escapeSeen === 1 && Boolean(document.querySelector("[data-edge-parent]"))'));
    }
    if (mode === "guard-popup") {
      await key("Escape");
      check("nested escGuard lets local popup consume first Escape", await evaluate(`document.querySelector("[data-edge-child]")?.textContent === "popup closed" && document.querySelectorAll('[role="dialog"]').length === 2`));
      await key("Escape");
      check("next Escape closes only nested card", await evaluate('!document.querySelector("[data-edge-child]") && Boolean(document.querySelector("[data-edge-parent]"))'));
    }
  }

  for (const width of [390, 630, 1180]) {
    await viewport(width, 800);
    await show("metrics");
    const actionsBefore = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-transcript-action]')].map(e => { const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; }))`);
    await click('[data-metrics-update]');
    await settleRender();
    const actionsAfter = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-transcript-action]')].map(e => { const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; }))`);
    const metrics = await layoutAudit();
    check(`metrics ${width}px controls remain stable when usage changes`, actionsBefore === actionsAfter);
    check(`metrics ${width}px no horizontal overflow`, metrics.overflowing.length === 0 && metrics.pageWidth <= width, metrics);
    check(`metrics ${width}px cache context and rate stay distinct`, await evaluate(`document.querySelector('[data-context-meter]').textContent.includes('109k') && document.querySelector('[data-token-cache-read]').textContent.includes('2.3M') && document.querySelector('[data-token-rate]').textContent.includes('1.8k')`));
    check(`metrics ${width}px provider capacity stays separate from session and compaction`, await evaluate(`document.querySelector('[data-context-limits]').textContent.includes('1.1M') && document.querySelector('[data-context-limits]').textContent.includes('120k') && document.querySelector('[data-context-meter]').textContent.includes('258k')`));
    await screenshot(`metrics-${width}`);
    await show("accounts");
    await waitFor('document.querySelector("[data-accounts-rows]")');
    const accounts = await layoutAudit();
    check(`accounts ${width}px long names and quota fit`, accounts.overflowing.length === 0 && accounts.pageWidth <= width, accounts);
    check(`accounts ${width}px both providers visible`, await evaluate(`document.querySelector('[data-accounts-rows]').textContent.includes('claude') && document.querySelector('[data-accounts-rows]').textContent.includes('codex')`));
    await screenshot(`accounts-${width}`);
  }

  await show("background-task");
  await waitFor(`document.querySelector('[data-task-status="running"]')`);
  await evaluate(`window.__UI_QA__.finishBackground('completed')`);
  await waitFor(`document.querySelector('[data-task-status="done"]')`);
  check("background task completes in place without a stale spinner", await evaluate(`document.querySelectorAll('[data-task-status]').length===1 && !document.querySelector('[data-task-status="running"]') && document.querySelector('[data-task-status="done"]').textContent.includes('finished')`));
  await evaluate(`window.__UI_QA__.finishBackground('failed')`);
  await waitFor(`document.querySelector('[data-task-status="failed"]')`);
  check("background task failure shows its reason", await evaluate(`document.querySelector('[data-task-status="failed"]').textContent.includes('exit 2')`));
  await evaluate(`window.__UI_QA__.finishBackground('stopped')`);
  await waitFor(`document.querySelector('[data-task-status="killed"]')`);
  check("background task stop is visibly distinct from success", await evaluate(`document.querySelector('[data-task-status="killed"]').textContent.includes('stopped')`));
  await show("transcript");
  await waitFor('document.querySelector("[data-transcript-fixture]")');
  const transcriptAudit = await evaluate(`(() => {
    const blocks = [...document.querySelectorAll("[data-transcript-fixture] [data-block]")];
    return {
      blockCount: blocks.length,
      toolGroups: blocks.filter((el) => String(el.getAttribute("data-bkey")).startsWith("t")).length,
      messageKeys: blocks.map((el) => el.getAttribute("data-msg-key")).filter(Boolean),
      texts: blocks.map((el) => (el.textContent || "").trim().slice(0, 80)),
      blankMessageKeys: blocks.filter((el) => el.hasAttribute("data-msg-key") && !(el.textContent || "").trim()).map((el) => el.getAttribute("data-msg-key")),
    };
  })()`);
  check("transcript groups adjacent tool rows once", transcriptAudit.toolGroups === 1, transcriptAudit);
  check("windowed transcript preserves original indices", JSON.stringify(transcriptAudit.messageKeys) === JSON.stringify(["ui-qa-agent#4", "ui-qa-agent#5"]), transcriptAudit);
  check("windowed transcript excludes out-of-range messages", !transcriptAudit.texts.some((text) => text.includes("outside")), transcriptAudit);
  check("transcript omits blank tool-only assistant cards", transcriptAudit.blankMessageKeys.length === 0, transcriptAudit);
  await screenshot("transcript-windowed");

  await viewport(1180, 760, true);
  await show("pane");
  await waitFor('document.querySelector("[data-ui-qa-pane]")');
  const paneInitial = await evaluate(`(() => {
    const root = document.querySelector('[data-ui-qa-pane="transcript"]');
    const voiceToggles = root.querySelectorAll('[aria-label="Show voice history"],[aria-label="Hide voice history"]');
    return { width: root.getBoundingClientRect().width, voiceToggleCount: voiceToggles.length };
  })()`);
  check("actual transcript pane is at most 630px wide", paneInitial.width <= 630, paneInitial);
  check("transcript header exposes exactly one Voice toggle", paneInitial.voiceToggleCount === 1, paneInitial);
  const contextMeter = await evaluate(`(() => {
    const meter = document.querySelector('[data-ui-qa-pane="transcript"] [data-context-meter]');
    return { state: meter?.getAttribute('data-context-meter'), text: meter?.textContent?.replace(/\\s+/g, ' ').trim() };
  })()`);
  check("transcript unknown context never renders billable usage as 100 percent",
    contextMeter.state === "unknown" && contextMeter.text.includes("unknown") && contextMeter.text.includes("/unknown") && !contextMeter.text.includes("922k") && !contextMeter.text.includes("100%"), contextMeter);
  await evaluate(`document.querySelector('[aria-label="Show voice history"]').click()`);
  await waitFor(`document.querySelectorAll('[data-ui-qa-pane="transcript"] [aria-label="Voice conversation"]').length === 1`);
  await evaluate(`document.querySelector('[aria-label="Close voice history"]').click()`);
  await waitFor(`document.querySelectorAll('[data-ui-qa-pane="transcript"] [aria-label="Voice conversation"]').length === 0`);
  check("pane voice history closes", await evaluate(`document.querySelectorAll('[data-ui-qa-pane="transcript"] [aria-label="Voice conversation"]').length === 0`));
  await evaluate(`document.querySelector('[aria-label="Show voice history"]').click()`);
  await waitFor(`document.querySelectorAll('[data-ui-qa-pane="transcript"] [aria-label="Voice conversation"]').length === 1`);
  check("pane voice history reopens once", await evaluate(`document.querySelectorAll('[data-ui-qa-pane="transcript"] [aria-label="Voice conversation"]').length === 1`));
  await evaluate(`document.querySelector('[aria-label="Close voice history"]').click()`);
  await waitFor(`document.querySelectorAll('[data-ui-qa-pane="transcript"] [aria-label="Voice conversation"]').length === 0`);
  await evaluate(`window.__UI_QA__.setVoiceActive(true)`);
  await waitFor(`document.querySelectorAll('[data-ui-qa-pane="transcript"] [aria-label="Voice conversation"]').length === 1`);
  check("active voice becomes visible without opening history", await evaluate(`document.querySelector('[data-ui-qa-pane="transcript"] [aria-label="Voice conversation"] button')?.textContent.includes("End voice")`));
  const paneLayout = await layoutAudit('document.querySelector(\'[data-ui-qa-pane="transcript"]\')');
  check("630px transcript pane has no horizontal overflow", paneLayout.overflowing.length === 0 && paneLayout.scopeScrollWidth <= paneLayout.scopeWidth + 1, paneLayout);
  check("630px transcript pane has no hidden focusable controls", paneLayout.hiddenInteractive.length === 0, paneLayout);
  check("active pane still has one Voice toggle", await evaluate(`document.querySelectorAll('[data-ui-qa-pane="transcript"] [aria-label="Show voice history"],[data-ui-qa-pane="transcript"] [aria-label="Hide voice history"]').length === 1`));
  await screenshot("transcript-pane-630-active-voice");
  await evaluate(`window.__UI_QA__.setVoiceActive(false)`);

  await viewport(780, 760, true);
  await show("voice");
  await waitFor(`document.querySelector('[aria-label="Voice conversation"]')`);
  await evaluate(`document.querySelector('[aria-label="Close voice history"]').click()`);
  check("voice history closes without duplicate panel", await evaluate(`document.querySelectorAll('[aria-label="Voice conversation"]').length === 0`));
  await evaluate('document.querySelector("[data-voice-toggle]").click()');
  await waitFor(`document.querySelector('[aria-label="Voice conversation"]')`);
  check("voice history reopens exactly once", await evaluate(`document.querySelectorAll('[aria-label="Voice conversation"]').length === 1`));
  const voiceMotion = await evaluate(`([...document.querySelectorAll('[aria-label="Voice conversation"] i')].map((el) => getComputedStyle(el).transitionDuration))`);
  check("voice meters honor reduced motion", voiceMotion.every((duration) => duration === "0s"), voiceMotion);
  const voiceLayout = await layoutAudit('document.querySelector(\'[data-ui-qa-pane="voice"]\')');
  check("voice 630px pane has no overflow", voiceLayout.scopeWidth <= 630 && voiceLayout.overflowing.length === 0 && voiceLayout.scopeScrollWidth <= voiceLayout.scopeWidth + 1, voiceLayout);
  await screenshot("voice-narrow-reduced-motion");

  await viewport(1180, 760);
  await show("queues");
  await waitFor(`document.querySelector('[data-queue-row="quality-queue"]')`);
  check("queues expose loading schedules state", await evaluate('document.body.textContent.includes("loading schedules")'));
  await evaluate('window.__UI_QA__.rejectSchedules()');
  await evaluate(`document.querySelector('[data-queue-row="quality-queue"]').click()`);
  await waitFor('document.querySelectorAll("[data-task-row]").length === 1');
  check("queues render populated state", await evaluate('document.querySelectorAll("[data-task-row]").length === 1'));
  await waitFor('document.body.textContent.includes("could not load schedules")');
  check("queues expose schedule error state", await evaluate('document.body.textContent.includes("synthetic schedule failure")'));
  await evaluate(`document.querySelector('[data-queue-row="empty-queue"]').click()`);
  await waitFor('document.body.textContent.includes("no tasks")');
  check("queues render empty task state", await evaluate('document.body.textContent.includes("no tasks")'));
  const queuesLayout = await layoutAudit('document.querySelector(\'[data-ui-qa-pane="queues"]\')');
  check("queues fit a 630px pane", queuesLayout.scopeWidth <= 630 && queuesLayout.overflowing.length === 0 && queuesLayout.scopeScrollWidth <= queuesLayout.scopeWidth + 1, queuesLayout);
  await screenshot("queues-narrow");

  await show("teams");
  await waitFor(`document.querySelector('[data-team-row="quality"]')`);
  check("teams render list and detail", await evaluate('document.body.textContent.includes("Synthetic UI regression fixture")'));
  const teamsLayout = await layoutAudit('document.querySelector(\'[data-ui-qa-pane="teams"]\')');
  check("teams fit a 630px pane", teamsLayout.scopeWidth <= 630 && teamsLayout.overflowing.length === 0 && teamsLayout.scopeScrollWidth <= teamsLayout.scopeWidth + 1, teamsLayout);
  check("teams have no hidden focusable controls", teamsLayout.hiddenInteractive.length === 0, teamsLayout);
  await screenshot("teams-narrow");

  for (const name of ["queues", "teams"]) {
    await show(name);
    if (name === "queues") {
      await evaluate(`document.querySelector('[data-queue-row="quality-queue"]').click()`);
      await waitFor('document.querySelectorAll("[data-task-row]").length === 1');
    }
    for (const width of [1180, 630, 390]) {
      for (const resized of [430, 560]) {
        const geometry = await evaluate(`new Promise((resolve) => {
          const pane = document.querySelector('[data-ui-qa-pane="${name}"]');
          pane.style.width = '${width}px';
          const row = pane.firstElementChild.firstElementChild;
          row.style.setProperty('--pane-w', '${resized}px');
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const master = row.firstElementChild, detail = row.querySelector(':scope > [class*="detail_"]');
            const r = (el) => el.getBoundingClientRect().toJSON();
            resolve({ pane: r(pane), row: r(row), master: r(master), detail: r(detail), direction: getComputedStyle(row).flexDirection, detailFlex: getComputedStyle(detail).flex, masterWidth: getComputedStyle(master).width });
          }));
        })`);
        const narrow = width <= 630;
        check(`${name} ${width}px resized ${resized}px master/detail geometry`, narrow
          ? geometry.direction === "column" && Math.abs(geometry.master.width - (width - 24)) < 2 && Math.abs(geometry.detail.width - (width - 24)) < 2 && Math.abs(geometry.detail.height - (name === "teams" ? 440 : 350)) < 2 && Math.abs(geometry.master.height - (name === "teams" ? 260 : 350)) < 2
          : geometry.direction === "row" && geometry.master.width === resized && geometry.detail.width > 500,
        geometry);
        if (name === "queues") {
          const summary = await evaluate(`(() => {
            const pane = document.querySelector('[data-ui-qa-pane="queues"]');
            const counts = pane.querySelector('[class*="countsRow_"]');
            const detail = pane.querySelector('[class*="detail_"]');
            const bounds = detail.getBoundingClientRect();
            const ancestors = [];
            for (let el = counts; el && el !== pane; el = el.parentElement) {
              const style = getComputedStyle(el);
              ancestors.push({ className: el.className, overflowX: style.overflowX, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
                userScrollable: /^(auto|scroll)$/.test(style.overflowX) && el.scrollWidth > el.clientWidth });
            }
            const items = [...counts.children].map(el => {
              const range = document.createRange(); range.selectNodeContents(el);
              const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
              return { text: el.textContent.replace(/\\s+/g, ' ').trim(), right: Math.max(...rects.map(r => r.right)),
                visible: rects.length > 0 && rects.every(r => r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom) };
            });
            const track = counts.querySelector('[class*="meterTrackWide_"]');
            const meterRects = [track, track?.firstElementChild].map(el => el?.getBoundingClientRect());
            const meter = { rects: meterRects.map(rect => rect?.toJSON()), visible: meterRects.every(rect => rect && rect.width > 0 && rect.height > 0
              && rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom) };
            return { bounds: bounds.toJSON(), items, ancestors, meter };
          })()`);
          check(`queues ${width}px resized ${resized}px named summary text visible`, summary.items.length === 6
            && ["pending", "blocked", "in_progress", "done", "failed", "backlog"].every(label => summary.items.some(item => item.text.startsWith(label) && item.visible)), summary);
          if (width === 390) check(`queues 390px resized ${resized}px backlog label value and meter visible`,
            summary.items.some(item => item.text === "backlog 100%" && item.visible) && summary.meter.visible, summary);
        }
        if (narrow) {
          const controls = await evaluate(`(() => {
            const pane = document.querySelector('[data-ui-qa-pane="${name}"]');
            const row = pane.firstElementChild.firstElementChild;
            const detail = row.querySelector(':scope > [class*="detail_"]');
            row.scrollTop = row.scrollHeight;
            const bounds = row.getBoundingClientRect();
            const targets = [...detail.querySelectorAll('button,[role="button"]')].filter(el => getComputedStyle(el).display !== 'none');
            return targets.map(el => { const r = el.getBoundingClientRect(); return { text: el.textContent, visible: r.width > 0 && r.height > 0 && r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom }; });
          })()`);
          check(`${name} ${width}px resized ${resized}px detail controls reachable`, controls.length > 0 && controls.every(control => control.visible), controls);
        }
      }
      await screenshot(`${name}-pane-${width}`);
    }
  }

  await viewport(1200, 800);
  await show("slash-codex");
  await waitFor(`document.querySelector('[data-slash-popup]')?.textContent.includes('goal')`);
  check("native Codex goal appears in slash menu", await evaluate(`document.querySelector('[data-slash-popup]').textContent.includes('Native goal')`));
  await show("slash-claude");
  await waitFor(`document.querySelector('[data-slash-popup]')?.textContent.includes('audit')`);
  check("Claude slash menu reflects SDK discovery", await evaluate(`document.querySelector('[data-slash-popup]').textContent.includes('SDK-discovered audit') && !document.querySelector('[data-slash-popup]').textContent.includes('goal')`));
  await evaluate(`window.__UI_QA__.clearComposer()`);
  await show("project-import");
  await waitFor(`document.querySelector('[data-import-model]')?.value === 'claude-opus-5-5' && !document.querySelector('[data-import-submit]')?.disabled`);
  check("project import offers provider account and flagship model", await evaluate(`document.querySelector('[data-import-provider]').value === 'claude' && document.querySelector('[data-import-account]').options.length === 2`));
  check("project Claude conductor defaults to full permissions", await evaluate(`document.querySelector('[data-import-permission]').value === 'full'`));
  await evaluate(`(() => { const el=document.querySelector('[data-import-account]');el.value='claude-work';el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(`document.querySelector('[data-import-account]')?.value === 'claude-work' && !document.querySelector('[data-import-submit]')?.disabled`);
  await evaluate(`(() => { const el=document.querySelector('[data-import-provider]');el.value='codex';el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(`document.querySelector('[data-import-model]')?.value === 'gpt-6-astra' && !document.querySelector('[data-import-submit]')?.disabled`);
  check("project provider switch resets account and model", await evaluate(`document.querySelector('[data-import-account]').value === 'codex' && document.querySelector('[data-import-account]').options.length === 1`));
  check("project Codex conductor preserves full permissions", await evaluate(`document.querySelector('[data-import-permission]').value === 'full' && !document.querySelector('[data-import-permission] option[value="full"]').disabled`));
  for (const width of [390, 780]) {
    await viewport(width, 844); await settleRender();
    await screenshot(`project-import-${width}`);
    check(`project import ${width}px controls fit`, await evaluate(`(() => {const card=document.querySelector('[data-project-import]');return card.scrollWidth<=card.clientWidth+1 && [...card.querySelectorAll('input,select,button')].every(el=>{const r=el.getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth+1;});})()`));
  }
  await evaluate(`(() => {const input=document.querySelector('[data-field="name"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'chosen-project');input.dispatchEvent(new Event('input',{bubbles:true}));const model=document.querySelector('[data-import-model]');model.value='gpt-6-sol';model.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click('[data-import-submit]');
  await waitFor(`window.__UI_QA__.projectImports().length === 1`);
  check("project creation submits chosen conductor routing", await evaluate(`(() => {const p=window.__UI_QA__.projectImports()[0];return p.name==='chosen-project' && p.conductorAccount==='codex' && p.conductorModel==='gpt-6-sol' && p.permissionProfile==='full';})()`));
  await show("project-import");
  await waitFor(`document.querySelector('[data-import-model]')?.value === 'claude-opus-5-5'`);
  await evaluate(`(() => { const el=document.querySelector('[data-import-provider]');el.value='auto';el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(`!document.querySelector('[data-import-submit]')?.disabled`);
  check("project global defaults clear explicit routing", await evaluate(`document.querySelector('[data-import-account]').value === '' && document.querySelector('[data-import-model]').value === ''`));
  await viewport(1200, 800);
  await show("quick-spawn");
  await click('[data-agent-action="agents.spawnDefault"]');
  await waitFor(`document.querySelector('[data-quick-spawn] [data-spawn-field="model"]')?.value === 'claude-opus-5-5' && !document.querySelector('[data-spawn-submit]')?.disabled`);
  const quickInitial = await evaluate(`({fields:[...document.querySelectorAll('[data-quick-spawn] [data-spawn-field]')].map(el=>el.dataset.spawnField), spawns:window.__UI_QA__.quickSpawns().length})`);
  check("quick spawn opens routing form without spawning", JSON.stringify(quickInitial.fields) === JSON.stringify(['provider','account','model']) && quickInitial.spawns === 0, quickInitial);
  await evaluate(`(() => { const el=document.querySelector('[data-spawn-field="provider"]');el.value='codex';el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await waitFor(`document.querySelector('[data-spawn-field="model"]')?.value === 'gpt-6-astra' && !document.querySelector('[data-spawn-submit]')?.disabled`);
  const quickRoute = await evaluate(`({account:document.querySelector('[data-spawn-field="account"]').value,accounts:[...document.querySelector('[data-spawn-field="account"]').options].map(el=>el.value), model:document.querySelector('[data-spawn-field="model"]').value})`);
  check("quick spawn provider switches account and flagship model", quickRoute.account === 'codex' && quickRoute.accounts.length === 1 && quickRoute.model === 'gpt-6-astra', quickRoute);
  for (const width of [390, 780]) {
    await viewport(width, 844); await settleRender();
    const fit = await evaluate(`(() => { const card=document.querySelector('[data-quick-spawn]');return {fits:card.scrollWidth <= card.clientWidth+1,controls:[...card.querySelectorAll('select,button')].every(el=>{const r=el.getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth+1;})};})()`);
    check(`quick spawn ${width}px controls fit`, fit.fits && fit.controls, fit);
  }
  await click('[data-spawn-submit]');
  await waitFor(`window.__UI_QA__.quickSpawns().length === 1 && !document.querySelector('[data-quick-spawn]')`);
  const quickSpec = await evaluate(`window.__UI_QA__.quickSpawns()[0]`);
  check("quick spawn preserves idle session defaults and selected routing", quickSpec.provider === 'codex' && quickSpec.account === 'codex' && quickSpec.model === 'gpt-6-astra' && quickSpec.session === true && quickSpec.resumeOnly === true && quickSpec.resume === null && quickSpec.autonomy === 'full' && quickSpec.compactionThreshold === 500000 && quickSpec.maxTurns === 120 && quickSpec.orchestration.allow === true, quickSpec);
  await click('[data-agent-action="agents.spawn"]');
  await waitFor(`document.querySelector('[data-spawn-field="prompt"]')`);
  check("full spawn form remains available", await evaluate(`!document.querySelector('[data-quick-spawn]') && !!document.querySelector('[data-spawn-field="role"]')`));
  await evaluate(`document.querySelector('[data-spawn-card] button:last-child').click()`);

  await viewport(1200, 800);
  await show("live-names");
  const hoverName = '[data-live-list] [data-agent-row] [data-hover-scroll]';
  const hoverTrack = '[data-live-list] [data-agent-row] [data-hover-scroll-track]';
  const longName = 'slack-thread-usage-investigation-with-a-complete-readable-agent-name-and-final-characters';
  await evaluate(`window.__UI_QA__.renameAgent(${JSON.stringify(longName)})`);
  await waitFor(`document.querySelector(${JSON.stringify(hoverName)})?.title.includes(${JSON.stringify(longName)})`);
  const hoverGeometry = () => evaluate(`(() => {const row=document.querySelector('[data-live-list] [data-agent-row]');return [...row.children].map(el=>{const r=el.getBoundingClientRect();return [r.left,r.width,r.height];});})()`);
  const beforeHover = await hoverGeometry();
  const hoverLabel = async () => {
    const point = await pointerPoint(hoverName);
    await call("Input.dispatchMouseEvent", { type:"mouseMoved", x:point.x, y:point.y }, sessionId);
    await settleRender();
  };
  await hoverLabel();
  await waitFor(`document.querySelector(${JSON.stringify(hoverTrack)}).getAnimations().length === 1`);
  const hoverEnd = await evaluate(`(() => {const track=document.querySelector(${JSON.stringify(hoverTrack)});track.getAnimations()[0].finish(); const r=track.getBoundingClientRect(),v=track.parentElement.getBoundingClientRect();return {left:r.left,right:r.right,viewportLeft:v.left,viewportRight:v.right};})()`);
  check("hover name scroll reveals final characters without moving columns", hoverEnd.left < hoverEnd.viewportLeft && Math.abs(hoverEnd.right-hoverEnd.viewportRight)<2 && JSON.stringify(beforeHover)===JSON.stringify(await hoverGeometry()),hoverEnd);
  await evaluate(`document.querySelector('[data-live-list]').style.width='520px'`);
  await settleRender();
  const resizedHover = await evaluate(`(() => {const track=document.querySelector(${JSON.stringify(hoverTrack)});track.getAnimations()[0].finish();return Math.abs(track.getBoundingClientRect().right-track.parentElement.getBoundingClientRect().right)<2;})()`);
  check("hover name recalculates scrolling after pane resize", resizedHover);
  await call("Input.dispatchMouseEvent", {type:"mouseMoved",x:1190,y:790},sessionId);
  await settleRender();
  check("hover name resets on pointer leave", await evaluate(`(() => {const track=document.querySelector(${JSON.stringify(hoverTrack)});return track.getAnimations().length===0 && getComputedStyle(track).transform==='none' && getComputedStyle(track.parentElement).textOverflow==='ellipsis';})()`));
  await viewport(1200,800,true); await hoverLabel();
  check("hover name respects reduced motion with full title", await evaluate(`document.querySelector(${JSON.stringify(hoverTrack)}).getAnimations().length===0 && document.querySelector(${JSON.stringify(hoverName)}).title.includes(${JSON.stringify(longName)})`));
  await call("Input.dispatchMouseEvent", {type:"mouseMoved",x:1190,y:790},sessionId);
  await viewport(1200,800,false);
  await evaluate(`window.__UI_QA__.renameAgent('Short name')`);
  await waitFor(`document.querySelector(${JSON.stringify(hoverName)})?.title.startsWith('Short name')`);
  await hoverLabel();
  check("hover name leaves fitting text still", await evaluate(`document.querySelector(${JSON.stringify(hoverTrack)}).getAnimations().length===0`));
  await call("Input.dispatchMouseEvent", {type:"mouseMoved",x:1190,y:790},sessionId);
  for (const width of [320,420,640]) {
    await evaluate(`document.querySelector('[data-live-list]').style.width='${width}px'; window.__UI_QA__.unreadAgent(false)`); await settleRender();
    const geometry = () => evaluate(`(() => { const row=document.querySelector('[data-live-list] [data-agent-row]'); return {height:row.getBoundingClientRect().height,cells:['name','state','cost','tokens','unseenSlot'].map(cls=>{const el=[...row.children].find(el=>el.className.includes(cls));const r=el.getBoundingClientRect();return [r.left,r.width];})};})()`);
    const read=await geometry();
    await evaluate('window.__UI_QA__.unreadAgent(true)');
    await waitFor(`document.querySelector('[data-live-list] [data-agent-action="agents.markSeen"]')`); await settleRender();
    const unread=await geometry();
    check(`unread indicator ${width}px keeps row columns stable`,JSON.stringify(read)===JSON.stringify(unread),{read,unread});
    const dot = await evaluate(`(() => {const b=document.querySelector('[data-live-list] [data-agent-action="agents.markSeen"]');return {label:b?.getAttribute('aria-label'),text:b?.textContent.trim(),radius:b?.firstElementChild && getComputedStyle(b.firstElementChild).borderRadius,html:b?.outerHTML};})()`);
    check(`unread indicator ${width}px uses accessible dot`,dot.label==='Unread activity — mark read' && dot.text==='' && dot.radius==='50%',dot);
    await evaluate('window.__UI_QA__.unreadAgent(false)');
    await waitFor(`!document.querySelector('[data-live-list] [data-agent-action="agents.markSeen"]')`); await settleRender();
    check(`unread indicator ${width}px clears without moving columns`,JSON.stringify(read)===JSON.stringify(await geometry()));
  }
  await evaluate(`document.querySelector('[data-live-list]').style.width='420px'`);

  await waitFor(`document.querySelector('[data-live-list]')?.textContent.includes('UI QA Agent')`);
  await evaluate(`window.__UI_QA__.renameAgent()`);
  await waitFor(`document.querySelector('[data-live-list]')?.textContent.includes('Monitoring investigator')`);
  check("live rename updates inspector list without reload", await evaluate(`!document.querySelector('[data-live-list]').textContent.includes('UI QA Agent')`));
  check("live rename updates transcript authors without reload", await evaluate(`document.querySelector('[data-live-transcript]').textContent.includes('Monitoring investigator') && !document.querySelector('[data-live-transcript]').textContent.includes('UI QA Agent')`));
  await evaluate(`window.__UI_QA__.softState('busy')`);
  await waitFor(`document.querySelector('[data-live-list] [aria-label="running · busy · over budget"]') || document.querySelector('[data-live-list] [class*="busyPulse"]')`);
  check("soft limit preserves busy running animation", await evaluate(`(() => { const e=document.querySelector('[data-live-list] [class*="busyPulse"]'); return !!e && getComputedStyle(e).animationName !== 'none' && !e.className.includes('toneWarn'); })()`));
  check("soft limit warning is separate from running header", await evaluate(`(() => { const e=document.querySelector('[data-live-transcript] [class*="stateChip"]'); return e?.textContent.trim() === '◐ running' && e.className.includes('toneSuccess') && document.querySelector('[data-soft-limit-warning]')?.textContent.includes('soft limit'); })()`));
  await screenshot("soft-limit-running");
  await viewport(1200, 800, true);
  check("soft limit running remains distinct with reduced motion", await evaluate(`(() => { const e=document.querySelector('[data-live-list] [class*="busyPulse"]'); return !!e && getComputedStyle(e).animationName === 'none' && e.className.includes('toneBusy'); })()`));
  await viewport(1200, 800, false);
  await evaluate(`window.__UI_QA__.softState('idle')`);
  await waitFor(`!document.querySelector('[data-live-list] [class*="busyPulse"]')`);
  check("soft limit idle retains running color without pulse", await evaluate(`(() => { const e=document.querySelector('[data-live-list] [role="img"][aria-label^="running"]'); return !!e && e.className.includes('toneSuccess') && !e.className.includes('toneWarn'); })()`));
  await evaluate(`window.__UI_QA__.softState('paused')`);
  await waitFor(`document.querySelector('[data-live-list] [role="img"][aria-label^="paused"]')`);
  check("actual pause remains paused despite prior soft limit", await evaluate(`(() => { const e=document.querySelector('[data-live-list] [role="img"][aria-label^="paused"]'); return e?.textContent === '⏸' && e.className.includes('toneWarn') && !document.querySelector('[data-soft-limit-warning]') && !document.querySelector('[data-live-list] [class*="busyPulse"]'); })()`));
  await show("secrets");
  await waitFor(`document.querySelectorAll('[data-secret-row]').length === 2`);
  await evaluate(`window.__UI_QA__.renameAgent()`);
  await waitFor(`document.querySelector('[aria-label="Secret store"]').textContent.includes('Monitoring investigator')`);
  check("secret grants follow live names rather than cached labels", await evaluate(`!document.querySelector('[aria-label="Secret store"]').textContent.includes('stale label')`));
  check("secret access management starts collapsed", await evaluate(`[...document.querySelectorAll('details')].every(d => !d.open) && !document.querySelector('[data-secret-value]')`));
  await screenshot("secrets-wide");
  await viewport(390, 850);
  await evaluate(`document.querySelector('summary').click()`);
  await evaluate(`document.querySelector('[data-secret-delete]').click()`);
  check("secret delete waits for explicit confirmation", await evaluate(`window.__UI_QA__.secretWrites().length === 0 && !!document.querySelector('[aria-label^="Confirm deletion"]')`));
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click()`);
  check("secret deletion cancel makes no mutation", await evaluate(`window.__UI_QA__.secretWrites().length === 0 && !document.querySelector('[aria-label^="Confirm deletion"]')`));
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('New secret')).click()`);
  check("secret values remain password inputs", await evaluate(`document.querySelector('[data-secret-value]').type === 'password'`));
  check("secret controls fit a 390px pane", await evaluate(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('input,select,button')].filter(e => e.getClientRects().length).every(e => { const r=e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })`));
  await screenshot("secrets-390");

  await viewport(1500, 940);
  await show("local-links");
  await waitFor(`document.querySelectorAll('[data-local-links] [role="button"]').length === 4`);
  await click('[data-local-links] [title="fixture: /synthetic/design/design-split.png"]');
  await waitFor(`document.querySelector('[data-file-viewer] img')?.naturalWidth > 0`);
  check("local markdown image link opens the actual file viewer", await evaluate(`document.querySelector('[data-file-viewer]').textContent.includes('design-split.png')`));
  await key("Escape");
  await waitFor(`!document.querySelector('[data-file-viewer]')`);
  await evaluate(`[...document.querySelectorAll('[data-local-links] [role="button"]')].find(e=>e.textContent==='Kullanım rehberi').focus()`);
  await key("Enter");
  await waitFor(`document.querySelector('[data-file-viewer-markdown]')?.textContent.includes('Design guide')`);
  check("local markdown guide supports keyboard opening and source toggle", await evaluate(`!document.querySelector('[data-file-viewer-raw-toggle]').disabled`));
  await click('[data-file-viewer-raw-toggle]');
  await waitFor(`!document.querySelector('[data-file-viewer-markdown]')`);
  check("local markdown guide source toggle displays source", await evaluate(`document.querySelector('[data-file-viewer]').textContent.includes('# Design guide')`));
  await key("Escape");
  await evaluate(`[...document.querySelectorAll('[data-local-links] [role="button"]')].find(e=>e.textContent==='Satır').focus()`);
  await key("Enter");
  await waitFor(`document.querySelector('[data-file-viewer]')`);
  check("local markdown line link opens source at requested line", await evaluate(`document.querySelector('[data-file-viewer-raw-toggle]').disabled && !document.querySelector('[data-file-viewer-markdown]') && !!document.querySelector('[data-file-viewer] .path-target-line')`));
  await key("Escape");
  await evaluate(`[...document.querySelectorAll('[data-local-links] [role="button"]')].find(e=>e.textContent==='Result guide').focus()`);
  await key("Enter");
  await waitFor(`document.querySelector('[data-file-viewer-markdown]')`);
  check("minimal markdown local link opens the shared viewer", await evaluate(`document.querySelector('[data-file-viewer-markdown]').textContent.includes('Design guide')`));
  await key("Escape");
  check("unresolved and unsafe markdown links remain inert without navigation", await evaluate(`document.querySelectorAll('[data-local-links] [role="button"]').length === 4 && !document.querySelector('[data-local-links] a') && !document.querySelector('[data-local-links] [title="javascript:alert"]').onclick && !!window.__UI_QA__`));

  await show("design");
  check("design starts in conversation without stealing focus", await evaluate(`!!document.querySelector('[data-design-conversation]') && !document.querySelector('iframe')`));
  await evaluate(`[...document.querySelectorAll('[aria-label="Inspector view"] button')].find(b => b.textContent === 'Design').click()`);
  await waitFor(`document.querySelector('iframe')?.srcdoc.includes('Keep things cool.')`);
  check("design loads the newest registered HTML snapshot", await evaluate(`document.querySelector('[aria-label="Design revision"]').value === 'design-v2'`));
  check("design frame has no script or same-origin sandbox permissions", await evaluate(`document.querySelector('iframe').getAttribute('sandbox') === '' && document.querySelector('iframe').contentDocument === null`));
  if (artifactDir) writeFileSync(join(artifactDir, "design-sanitized.html"), await evaluate("document.querySelector('iframe').srcdoc"));
  check("design strips scripts navigation embeds and event handlers", await evaluate(`(() => { const s=document.querySelector('iframe').srcdoc; return !s.includes('<script') && !s.includes('<iframe') && !s.includes('http-equiv="refresh"') && !s.includes('onerror=') && !s.includes('href=') && s.includes("script-src 'none'") && s.includes("connect-src 'none'"); })()`));
  await evaluate(`document.querySelector('[aria-label="Design revision"]').value='design-v1';document.querySelector('[aria-label="Design revision"]').dispatchEvent(new Event('change',{bubbles:true}))`);
  await waitFor(`document.querySelector('iframe')?.srcdoc.includes('Earlier design')`);
  check("design revision selection restores the immutable prior snapshot", await evaluate(`!document.querySelector('iframe').srcdoc.includes('Keep things cool.')`));
  await click('[data-design-switch]');
  await waitFor(`document.querySelector('iframe')?.srcdoc.includes('Other agent design')`);
  check("design agent switch never shows another agents snapshot", await evaluate(`!document.querySelector('iframe').srcdoc.includes('Earlier design')`));
  await click('[data-design-switch]');
  await waitFor(`document.querySelector('iframe')?.srcdoc.includes('Earlier design')`);
  check("design restores selected revision when returning to an agent", await evaluate(`document.querySelector('[aria-label="Design revision"]').value === 'design-v1'`));
  await evaluate(`[...document.querySelectorAll('[aria-label="Design controls"] button')].find(b => b.textContent === 'Source').click()`);
  await waitFor(`document.querySelector('[aria-label="Design source"]')`);
  check("design source displays original HTML as text", await evaluate(`document.querySelector('[aria-label="Design source"]').textContent.includes('<h1>Monitoring') && !document.querySelector('iframe')`));
  await evaluate(`[...document.querySelectorAll('[aria-label="Design controls"] button')].find(b => b.textContent === 'Preview').click(); document.querySelector('[aria-label="Design revision"]').value='design-v2'; document.querySelector('[aria-label="Design revision"]').dispatchEvent(new Event('change',{bubbles:true}))`);
  await waitFor(`document.querySelector('iframe')?.srcdoc.includes('Keep things cool.')`);
  await evaluate(`document.querySelector('[aria-label="Design viewport"]').value='390';document.querySelector('[aria-label="Design viewport"]').dispatchEvent(new Event('change',{bubbles:true}))`);
  await settleRender();
  check("design mobile viewport uses an actual 390px frame", await evaluate(`Math.round(document.querySelector('iframe').getBoundingClientRect().width) === 390`));
  await screenshot("design-mobile");
  await evaluate(`[...document.querySelectorAll('[aria-label="Inspector view"] button')].find(b => b.textContent === 'Side by side').click()`);
  await settleRender();
  check("design wide split preserves conversation beside canvas", await evaluate(`document.querySelector('[data-design-conversation]').getBoundingClientRect().width > 0 && document.querySelector('[data-view="split"]').getBoundingClientRect().width > document.querySelector('iframe').getBoundingClientRect().width`));
  await screenshot("design-split");
  await viewport(390, 850);
  await settleRender();
  check("design narrow split stacks and keeps controls in bounds", await evaluate(`(() => { const p=document.querySelector('[data-view="split"]'); return getComputedStyle(p).flexDirection === 'column' && document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('select,button')].filter(e=>e.getClientRects().length).every(e=>e.getBoundingClientRect().right <= innerWidth+1); })()`));
  await screenshot("design-narrow");
  check("design inert parsing and preview make no resource requests", designLeaks === 0);
  check("design rejects oversize source before parsing", await evaluate(`(() => { try { window.__UI_QA__.designSanitize('a'.repeat(1048577)); return false; } catch(e) { return e.message.includes('1 MiB'); } })()`));
  await show("design-error");
  await waitFor(`document.querySelector('[role="alert"]')`);
  check("design list failures are visible and retryable", await evaluate(`document.querySelector('[role="alert"]').textContent.includes('Synthetic list failure') && [...document.querySelectorAll('button')].some(b=>b.textContent==='Refresh'&&!b.disabled)`));
  await show("design-large");
  await waitFor(`document.querySelector('[role="alert"]')`);
  check("design oversized snapshots are rejected before native read", await evaluate(`document.querySelector('[role="alert"]').textContent.includes('1 MiB')`));

  await viewport(1000, 900);
  await show("keyboard");
  await focus("[data-keyboard-input]");
  const primaryModifier = await evaluate(`/mac/i.test(navigator.platform) ? 4 : 2`);
  await key("k", primaryModifier);
  check("keyboard leader is visible while composing", await evaluate(`document.querySelector('footer [role="status"]').textContent.includes('choose a key')`));
  await key("n");
  check("keyboard sequence dispatches once without changing draft", await evaluate(`document.querySelector('[data-keyboard-runs]').textContent === '1' && document.querySelector('[data-keyboard-input]').value === 'A draft to preserve'`));
  await key("k", primaryModifier); await key("Escape"); await key("n");
  check("keyboard escape cancels the pending sequence", await evaluate(`document.querySelector('[data-keyboard-runs]').textContent === '1'`));
  await key(" ", 1);
  check("keyboard alt space does not start voice", await evaluate(`document.querySelector('[data-keyboard-voices]').textContent === '0'`));
  await key("k", primaryModifier); await key("v");
  check("keyboard voice uses the leader sequence", await evaluate(`document.querySelector('[data-keyboard-voices]').textContent === '1'`));
  await focus("[data-keyboard-input]"); await key("Tab");
  check("keyboard tab preserves native focus navigation", await evaluate(`document.activeElement === document.querySelector('[data-keyboard-next]')`));
  await key("k", primaryModifier); await key("Escape");

  await viewport(1000, 900);
  await show("workspace-tools");
  const toolButton = async name => { await evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(b=>b.textContent.trim()===${JSON.stringify(name)})?.click()`); await settleRender(); };
  const choose = async (label,value) => { await evaluate(`(() => { const el=document.querySelector('select[aria-label="${label}"]'); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); })()`); await settleRender(); };
  await input('[aria-label="Prompt name"]', 'Review template');
  await input('[aria-label="Prompt template"]', 'Review {{branch}} carefully'); await settleRender();
  await input('[aria-label="Variable branch"]', 'main');
  await toolButton("Save prompt"); await toolButton("Insert prompt");
  check("workspace parameterized prompts append without sending", await evaluate(`window.__UI_QA__.workspaceSnapshot().data.snippets[0].name==='Review template' && window.__UI_QA__.workspaceSnapshot().composer.endsWith('Review main carefully')`));
  await toolButton("Drafts"); await input('[aria-label="Draft name"]','Review draft'); await toolButton("Stash current draft");
  await toolButton("Restore");
  check("workspace draft restore protects existing composer", await evaluate(`document.querySelector('[role="status"]').textContent.includes('before restoring') && window.__UI_QA__.workspaceSnapshot().data.drafts.length===1`));
  await evaluate('window.__UI_QA__.clearComposer()'); await toolButton("Restore");
  check("workspace draft restores after composer is empty", await evaluate(`window.__UI_QA__.workspaceSnapshot().composer.endsWith('Review main carefully')`));
  await toolButton("Notes"); await input('[aria-label="Operator notes"]','Local operator reminder'); await toolButton("Save notes");
  check("workspace notes save separately from transcript", await evaluate(`Object.values(window.__UI_QA__.workspaceSnapshot().data.notes).includes('Local operator reminder') && !window.__UI_QA__.workspaceSnapshot().composer.includes('operator reminder')`));
  await toolButton("Views"); await input('[aria-label="View name"]','Daily view'); await toolButton("Save current view");
  check("workspace saves fleet filter settings", await evaluate(`window.__UI_QA__.workspaceSnapshot().data.filters[0].name==='Daily view' && typeof window.__UI_QA__.workspaceSnapshot().data.filters[0].showDone==='boolean'`));
  await toolButton("Export"); await toolButton("Export Markdown");
  await waitFor(`document.querySelector('[role="status"]').textContent.includes('.md')`);
  check("workspace export reports the loaded window scope", await evaluate(`document.querySelector('[role="dialog"]').textContent.includes('currently loaded transcript window')`));
  await toolButton("Bookmarks");
  const bookmarkOption=await evaluate(`document.querySelector('[aria-label="Bookmark turn"] option:not([disabled])')?.value`);
  if(bookmarkOption!==undefined) await choose('Bookmark turn',bookmarkOption);
  check("workspace bookmarks persist a real transcript turn", await evaluate(`window.__UI_QA__.workspaceSnapshot().data.bookmarks.length===1`));
  await evaluate(`document.querySelector('[aria-label="Bookmark turn"]').closest('section').querySelector('div button')?.click()`); await settleRender();
  check("workspace bookmarks navigate to the saved turn", await evaluate(`window.__UI_QA__.bookmarkOpened()===1`));
  await toolButton("Compaction");
  check("workspace compaction states bounded event history", await evaluate(`document.querySelector('[role="dialog"]').textContent.includes('Older events may be absent')`));
  await toolButton("Display"); await choose('Text size','larger'); await choose('Control density','comfortable');
  check("workspace readability settings apply to app tokens", await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--fs-body').trim()==='17px' && getComputedStyle(document.documentElement).getPropertyValue('--control-h').trim()==='36px'`));
  await choose('Text size','standard'); await choose('Control density','compact');
  for(const width of [390,768,1440]) {
    await viewport(width,900);
    for(const category of ['Prompts','Drafts','Notes','Bookmarks','Views','Display','Export','Compaction']) {
      await toolButton(category);
      const fits=await evaluate(`(() => {const d=document.querySelector('[role="dialog"]');const r=d.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && d.scrollWidth<=d.clientWidth+1;})()`);
      check(`workspace ${category} ${width}px fits dialog grid`,fits);
    }
    await screenshot(`workspace-tools-${width}`);
  }

  for (const width of [390, 768, 1440]) {
    await viewport(width, 900);
    for (const screen of ["projects", "memory", "events", "roles", "inbox", "slo", "runs", "help", "agents", "settings", "teams", "queues", "review", "welcome"]) {
      await show(`screen-${screen}`);
      await waitFor(`document.querySelector('[data-screen-probe="${screen}"]')?.textContent.length > 0`);
      const layout = await evaluate(`(() => {
        const root = document.querySelector('[data-screen-probe]');
        const bounds = root.getBoundingClientRect();
        const overflow = [...root.querySelectorAll('*')].filter(el => {
          const r=el.getBoundingClientRect(); if(!r.width || !r.height) return false;
          if(r.left >= bounds.left-1 && r.right <= bounds.right+1) return false;
          let parent=el.parentElement;
          while(parent && parent!==root) { if(/auto|scroll|hidden/.test(getComputedStyle(parent).overflowX)) return false; parent=parent.parentElement; }
          return true;
        }).map(el=>({tag:el.tagName,text:el.textContent.slice(0,60)})).slice(0,6);
        const footer = document.querySelector("footer")?.getBoundingClientRect();
        return {overflow, pageWidth: document.documentElement.scrollWidth, width: innerWidth, footerBottom: footer?.bottom ?? 0, height: innerHeight, text: root.textContent.slice(0,80)};
      })()`);
      check(`screen ${screen} ${width}px stays within shared grid`, layout.pageWidth <= width && layout.overflow.length === 0 && layout.footerBottom <= layout.height + 1, layout);
      if(screen==='settings') {
        const cardsFit=await evaluate(`Array.from(document.querySelectorAll('[data-provider-catalog-card]')).every(card=>{const r=card.getBoundingClientRect();return [...card.querySelectorAll('*')].every(el=>{const b=el.getBoundingClientRect();return !b.width || (b.left>=r.left-1 && b.right<=r.right+1);});})`);
        check(`settings provider cards ${width}px keep details inside grid`,cardsFit);
      }
      if(screen==='agents') {
        await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Focus workspace')?.click()`); await settleRender();
        check(`focus workspace ${width}px preserves transcript and hides fleet`,await evaluate(`(() => {const r=document.querySelector('[data-screen-layout="split"]'); return r && getComputedStyle(r.children[0]).display==='none' && getComputedStyle(r.lastElementChild).display!=='none';})()`));
        await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Restore fleet pane')?.click()`); await settleRender();
      }
      await screenshot(`screen-${screen}-${width}`);
    }
  }
  const counts = reporter.counts;
  console.log(`UI browser checks: ${counts.passed} passed, ${counts.failed} failed`);
  await viewport(1200, 900);
  await show("group-order");
  await waitFor(`document.querySelector('[data-group-box="one"] [data-agent-row="sort-child"]')`);
  let nativeDragData = null;
  const stopDragListener = cdp.onEvent(message => {
    if (message.method === "Input.dragIntercepted") nativeDragData = message.params.data;
  });
  await call("Input.setInterceptDrags", { enabled: true }, sessionId);
  const dragRow = async (source, target, after = false) => {
    await evaluate(`document.querySelector(${JSON.stringify(source)}).scrollIntoView({block:'nearest'})`);
    await settleRender();
    const start = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(source)}).getBoundingClientRect();return {x:r.left+8,y:r.top+r.height/2};})()`);
    nativeDragData = null;
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...start }, sessionId);
    await call("Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", clickCount: 1 }, sessionId);
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x + 20, y: start.y + 3, button: "left", buttons: 1 }, sessionId);
    for (let attempt = 0; attempt < 30 && !nativeDragData; attempt++) await settleRender();
    assert.ok(nativeDragData, `native drag did not start: ${source}`);
    const data = nativeDragData;
    await evaluate(`document.querySelector(${JSON.stringify(target)}).scrollIntoView({block:'nearest'})`);
    await settleRender();
    const point = await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect();return {x:r.left+8,y:${after} ? r.bottom-2 : r.top+2};})()`);
    for (const type of ["dragEnter", "dragOver", "drop"]) await call("Input.dispatchDragEvent", { type, ...point, data }, sessionId);
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }, sessionId);
    await settleRender();
    return { agentMime: data.items.find(item => item.mimeType === 'application/x-chimera-agent')?.data, operations: data.dragOperationsMask };
  };
  const groupIds = () => evaluate(`[...document.querySelectorAll('[data-group-box]')].map(el=>el.dataset.groupBox)`);
  await dragRow('[data-group-drag="two"]', '[data-group-box="one"]');
  check("inspector groups reorder by dragging header", JSON.stringify(await groupIds()) === JSON.stringify(['two','one']));
  const dragInfo = await dragRow('[data-agent-row="sort-b"]', '[data-agent-row="sort-a"]');
  const members = await evaluate(`[...document.querySelectorAll('[data-group-box="one"] [data-agent-row]')].map(el=>el.dataset.agentRow)`);
  check("inspector agent reorder preserves subtree and quote payload", JSON.stringify(members) === JSON.stringify(['sort-b','sort-a','sort-child']) && dragInfo.agentMime === 'sort-b' && (dragInfo.operations & 17) === 17, { members, dragInfo });
  await dragRow('[data-agent-row="sort-v"]', '[data-agent-row="sort-u"]');
  check("inspector ungrouped agents reorder", await evaluate(`!!(document.querySelector('[data-agent-row="sort-v"]').compareDocumentPosition(document.querySelector('[data-agent-row="sort-u"]')) & Node.DOCUMENT_POSITION_FOLLOWING)`));
  await show("topbar"); await show("group-order");
  await waitFor(`document.querySelector('[data-group-box="one"] [data-agent-row="sort-child"]')`);
  check("inspector ordering survives remount", JSON.stringify(await groupIds()) === JSON.stringify(['two','one']) && await evaluate(`document.querySelector('[data-group-box="one"] [data-agent-row]').dataset.agentRow === 'sort-b'`));
  await dragRow('[data-agent-row="sort-child"]', '[data-ungroup-drop]');
  await waitFor(`document.querySelector('[data-agent-row="sort-child"]') && !document.querySelector('[data-group-box="one"] [data-agent-row="sort-child"]')`);
  check("inspector drag removes inherited group membership", await evaluate(`window.__UI_QA__.groupMoves().some(move=>move.agentId==='sort-child' && move.groups.length===0) && !document.querySelector('[data-agent-row="sort-child"]').closest('[data-group-box]')`));
  await dragRow('[data-agent-row="sort-child"]', '[data-group-box="two"]');
  await waitFor(`document.querySelector('[data-group-box="two"] [data-agent-row="sort-child"]')`);
  check("inspector dragging into group retains membership gesture", await evaluate(`window.__UI_QA__.groupMoves().some(move=>move.agentId==='sort-child' && move.groups[0]==='two')`));
  await evaluate(`window.__UI_QA__.failNextGroupMove()`);
  await dragRow('[data-agent-row="sort-child"]', '[data-group-box="one"]');
  check("inspector failed move keeps previous placement", await evaluate(`!!document.querySelector('[data-group-box="two"] [data-agent-row="sort-child"]') && !document.querySelector('[data-group-box="one"] [data-agent-row="sort-child"]')`));
  await viewport(390, 844); await settleRender();
  check("inspector ungroup drop fits narrow viewport", await evaluate(`(() => {const el=document.querySelector('[data-ungroup-drop]'),r=el.getBoundingClientRect();return el.scrollWidth<=el.clientWidth+1 && r.left>=0 && r.right<=innerWidth+1;})()`));
  await screenshot("inspector-order-narrow");
  await evaluate(`window.__UI_QA__.addLineageAgents()`);
  await waitFor(`document.querySelector('[data-agent-row="live-nested"]')`);
  const liveFamily = await evaluate(`[...document.querySelectorAll('[data-group-box="one"] [data-agent-row]')].map(el=>el.dataset.agentRow)`);
  check("inspector live children stay with owner after manual sorting", JSON.stringify(liveFamily) === JSON.stringify(['sort-b','live-queue','live-nested','live-direct','sort-a']), {liveFamily});
  await evaluate(`window.__UI_QA__.foldLineageOwner()`);
  await settleRender();
  check("inspector owner fold hides direct and queue descendants", await evaluate(`!!document.querySelector('[data-agent-row="sort-b"]') && !document.querySelector('[data-agent-row="live-direct"]') && !document.querySelector('[data-agent-row="live-queue"]') && !document.querySelector('[data-agent-row="live-nested"]')`));

  await call("Input.setInterceptDrags", { enabled: false }, sessionId);
  stopDragListener();

  await show("workflow-transcript");
  await waitFor(`document.querySelector('[data-agent-link="shadow:workflow-owner:old"]')`);
  check("native workflows stay out of fleet list", await evaluate(`!!document.querySelector('[data-agent-row="workflow-owner"]') && !document.querySelector('[data-agent-row^="shadow:workflow-owner:"]') && document.querySelectorAll('[data-workflow-probe] [data-agent-link^="shadow:workflow-owner:"]').length === 2`));
  await click('[data-agent-link="shadow:workflow-owner:old"]');
  await waitFor(`document.querySelector('[data-inspected-workflow="shadow:workflow-owner:old"]')`);
  check("workflow transcript links open the exact completed run", await evaluate(`document.querySelector('[data-inspected-workflow="shadow:workflow-owner:old"]').textContent.includes('done')`));
  await evaluate(`document.querySelector('[data-agent-link="shadow:workflow-owner:new"]').focus()`);
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId);
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId);
  await waitFor(`document.querySelector('[data-inspected-workflow="shadow:workflow-owner:new"]')`);
  check("workflow transcript links open the exact running run by keyboard", await evaluate(`document.querySelector('[data-inspected-workflow="shadow:workflow-owner:new"]').textContent.includes('running') && !document.querySelector('[data-inspected-workflow="shadow:workflow-owner:old"]')`));

  if (artifactDir) console.log(`UI browser screenshots: ${artifactDir}`);
  } finally {
    try { cdp?.close(); } finally {
      try { await terminateOwnedProcess(chrome); } finally {
        try { await vite?.close(); } finally { await removeScratchDirectory(scratch); }
      }
    }
  }
}, { requiredCheckIds: REQUIRED_CHECK_IDS.ui });
process.exitCode = suiteExitCode;
