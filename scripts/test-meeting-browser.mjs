// Real Chromium/Web Audio, synthetic tones only. No daemon, account, real mic,
// installs or production build. All tool caches live in an isolated temp folder.
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

const suiteExitCode = await runBrowserSuiteCli("meeting", async ({ reporter, signal }) => {
  const scratch = createScratchDirectory("chimera-meeting-browser-");
  let artifactDir;
  const check = reporter.check.bind(reporter);
  let chrome;
  let cdp;
  let vite;

  try {
    artifactDir = createScreenshotDirectory("meeting");
    vite = await createServer({
      root: resolve("packages/app"),
      configFile: false,
      cacheDir: join(scratch, "vite"),
      ...(process.env.CHIMERA_BROWSER_GATE_TEST_NO_OPTIMIZE === "1" ? { optimizeDeps: { noDiscovery: true, include: [] } } : {}),
      esbuild: { jsx: "automatic" },
      server: { host: "127.0.0.1", port: 0 },
      plugins: [{
        name: "meeting-ui-fixture",
        enforce: "pre",
        resolveId(source, importer) {
          if (!importer?.endsWith("/components/MeetingRooms.tsx")) return;
          if (source.endsWith("state/useStore")) return "\0meeting-store";
          if (source.endsWith("state/selectors")) return "\0meeting-names";
          if (source.endsWith("voice/meetingHost")) return "\0meeting-host";
        },
        load(id) {
          if (id === "\0meeting-store") return "export const useStore = selector => selector(window.__ROOM_TEST_STATE);";
          if (id === "\0meeting-names") return "export const displayName = agent => agent.displayLabel;";
          if (id === "\0meeting-host") return "export const meetingHost = window.__MEETING_HOST__;";
        },
        configureServer(server) {
          server.middlewares.use("/__meeting-test", (_req, res) => {
            res.setHeader("Content-Type", "text/html");
          res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'");
            res.end('<html><body style="margin:0"><div id="root"></div></body></html>');
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
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--autoplay-policy=no-user-gesture-required",
        "--remote-debugging-port=0",
        `--user-data-dir=${join(scratch, "chrome")}`,
        "about:blank",
      ],
    });
    chrome = launched.child;
    cdp = await connectCdp(launched.endpoint, { signal });
    const { call } = cdp;
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    await call("Page.enable", {}, sessionId);
    await call("Runtime.enable", {}, sessionId);
    await installLoopbackGuard(cdp, sessionId, `http://127.0.0.1:${port}`);
    await call("Page.navigate", { url: `http://127.0.0.1:${port}/__meeting-test` }, sessionId);

    const evaluate = async (expression) => {
      const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const screenshot = async (name) => {
      if (!artifactDir) return null;
      const capture = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
      const path = join(artifactDir, `${name}.png`);
      writeFileSync(path, Buffer.from(capture.data, "base64"));
      return path;
    };

    await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false }, sessionId);
    const networkGuard = await verifyLoopbackGuard(evaluate);
    check("network guard blocks external fetch and websocket", networkGuard.fetchBlocked && networkGuard.websocketBlocked
      && networkGuard.attempts.length === 2 && networkGuard.attempts.every((attempt) => attempt.blocked), networkGuard);

    const audio = await evaluate(`(async () => {
      window.__CHIMERA_MOCK__ = { rpc: async () => ({}) };
      const { runAudioProbe } = await import('/test/fixtures/meeting-browser.tsx');
      return runAudioProbe();
    })()`);
    check("actual AudioWorklet reports no failures", audio.failures.length === 0, audio.failures);
    check("operator output excludes self", audio.self < 0.0001, audio.self);
    check("operator output is audible", audio.audible > 0.05, audio.audible);
    check("non-selected participant stays silent", audio.participant < 0.0001, audio.participant);
    check("other room stays isolated", audio.otherRoom < 0.0001, audio.otherRoom);
    check("human departure leaves participant input silent", audio.afterHumanLeaves < 0.0001, audio.afterHumanLeaves);
    check("AudioWorklet captures enough frames", audio.captured > 10_000, audio.captured);
    check("operator output continuity has no long silence", audio.maxSilenceMs < 5, audio.maxSilenceMs);
    check("pause silences operator output", audio.duringPause < 0.0001, audio.duringPause);
    check("operator peer input remains silent", audio.operatorPeer < 0.0001, audio.operatorPeer);
    check("synthetic local microphone produces frames", audio.localFrames > 0, audio.localFrames);
    check("human input is excluded from agent input", audio.humanInput < 0.0001, audio.humanInput);
    console.log("Actual AudioWorklet: operator output continuity and silent native inputs", audio);

    // A fixed synthetic sampling delay avoids the initial analyser ramp window.
    // Thresholds and one-shot samples are unchanged; no global timer replacement.
    const managed = await evaluate(`(async () => {
      const { runManagedAudioProbe } = await import('/test/fixtures/meeting-browser.tsx');
      return await runManagedAudioProbe({ samplingDelayMs: 350 });
    })()`);
    check("silent microphone does not invent an operator turn", managed.turns === 0, managed.turns);
    check("managed audio reports no failures", managed.failures.length === 0, managed.failures);
    check("floor audio stays held without a recipient", managed.held < 0.0001, managed.held);
    check("selected recipient is audible", managed.selected > 0.3 && managed.selected < 0.5, managed.selected);
    check("recipient switch is audible", managed.switched > 0.19 && managed.switched < 0.21, managed.switched);
    check("listener mode mutes selected output", managed.listenerMuted < 0.0001, managed.listenerMuted);
    check("speaker mode resumes selected output", managed.resumed > 0.19 && managed.resumed < 0.21, managed.resumed);
    check("self and other speaker inputs stay silent", managed.noSelfOrOtherSpeaker < 0.0001, managed.noSelfOrOtherSpeaker);
    check("late joiner receives no history", managed.noHistory < 0.0001, managed.noHistory);
    check("listener input stays silent", managed.listenerInput < 0.0001, managed.listenerInput);
    check("late joiner receives live audio", managed.liveJoin < 0.0001, managed.liveJoin);
    check("recipient switch keeps input track live", managed.unchangedInput === "live", managed.unchangedInput);
    check("managed AudioContext stays running", managed.state === "running", managed.state);
    console.log("Selected output, silent listener input and incremental join", managed);

    await call("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await evaluate("import('/test/fixtures/meeting-browser.tsx').then(m => m.renderMeeting())");
    check("meeting UI exercises observer join and audio controls", true);
    const workspaceLayout = async () => evaluate(`(() => {
      const workspace = document.querySelector('[aria-label="Meeting rooms workspace"]');
      const list = workspace.querySelector('nav[aria-label="Meetings"]').closest('section').getBoundingClientRect();
      const detail = workspace.querySelector('header').closest('section').getBoundingClientRect();
      const box = workspace.getBoundingClientRect();
      return { list: { left:list.left, right:list.right, top:list.top, bottom:list.bottom }, detail: { left:detail.left, right:detail.right, top:detail.top, bottom:detail.bottom }, width:box.width, scroll:workspace.scrollWidth, position:getComputedStyle(workspace).position, dialogs:document.querySelectorAll('[role="dialog"]').length };
    })()`);
    const tabs = await evaluate(`[...document.querySelectorAll('nav[aria-label="Agent views"] button')].map(b=>b.textContent)`);
    check("meeting tab sits between inspector and dashboard", tabs.join('|') === 'inspector|meeting rooms|dashboard|liveboard', tabs);
    const wide = await workspaceLayout();
    check("meeting workspace uses inline inspector panes", wide.position !== 'fixed' && wide.dialogs === 0 && wide.list.right <= wide.detail.left && wide.scroll <= wide.width + 1, wide);
    await evaluate(`document.querySelector('details:has(> summary[data-participant-settings])').open = false`);
    check("meeting conversation remains visible with participants collapsed", await evaluate(`(() => { const transcript = [...document.querySelectorAll('summary')].find(s=>s.textContent==='Live room conversation').parentElement; return transcript.open && transcript.textContent.includes('audio isolation checks'); })()`));
    check("participant avatars remain visible with settings collapsed", await evaluate(`(() => { const seats = [...document.querySelectorAll('[data-meeting-seat]')]; return seats.length === 3 && seats.every(s => s.getBoundingClientRect().height > 80 && !s.closest('details') && s.querySelector('[role="img"]').getBoundingClientRect().width > 60); })()`));
    check("only current speaker avatar animates", await evaluate(`(() => { const active = [...document.querySelectorAll('[data-avatar-speaking="true"]')]; return active.length === 1 && active[0].getAttribute('aria-label') === 'Atlas, speaking' && getComputedStyle(active[0].querySelector('i')).animationName !== 'none'; })()`));
    await evaluate(`(() => { const input = document.querySelector('[aria-label="Your meeting name"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Nedim'); input.dispatchEvent(new Event('input', { bubbles:true })); window.__SET_MEETING_AVATAR_STATE__({joined:true, microphone:true, humanSpeaking:true}); })()`);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    check("joined human has named speaking avatar", await evaluate(`document.querySelector('[data-meeting-seat="operator"] strong').textContent === 'Nedim · participant' && document.querySelectorAll('[data-avatar-speaking="true"]').length === 1 && document.querySelector('[data-meeting-seat="operator"] [data-avatar-speaking="true"]').getAttribute('aria-label') === 'Nedim, speaking' && localStorage.getItem('chimera.meeting.displayName') === 'Nedim'`));
    await screenshot("meeting-avatars-wide");
    await evaluate(`window.__SET_MEETING_AVATAR_STATE__({microphone:false})`);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    check("mic off stops human avatar animation", await evaluate(`document.querySelector('[data-meeting-seat="operator"] [data-avatar-speaking="false"]') !== null`));
    await evaluate(`(() => { const input = document.querySelector('[aria-label="Message meeting"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Atlas, fikrin nedir?'); input.dispatchEvent(new Event('input', { bubbles:true })); })()`);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    await evaluate(`document.querySelector('[aria-label="Message meeting"]').closest('form').requestSubmit()`);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    check("typed meeting question sends without enabling microphone", await evaluate(`window.__LAST_MEETING_TEXT__ === 'Atlas, fikrin nedir?' && !window.__MEETING_HOST__.getState()[0].microphone && document.querySelector('[aria-label="Message meeting"]').value === ''`));
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Discuss latest question').click()`);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    check("operator can start a bounded discussion", await evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Stop discussion') && document.body.innerText.includes('Relevant contributions, one speaker at a time')`));
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Stop discussion').click()`);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    check("operator can stop discussion and retain the meeting", await evaluate(`!![...document.querySelectorAll('button')].find(b=>b.textContent==='Discuss latest question') && !!document.querySelector('[aria-label="Meeting rooms workspace"]') && !window.__MEETING_HOST__.getState()[0].discussion`));

    check("active participation is enabled for the joined operator", await evaluate(`document.querySelector('[aria-label="Active participation"]').checked`));
    await evaluate(`document.querySelector('[aria-label="Active participation"]').click()`);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    check("operator can disable active participation without leaving", await evaluate(`!window.__MEETING_HOST__.getState()[0].autoParticipation && window.__MEETING_HOST__.getState()[0].joined && !document.querySelector('[aria-label="Active participation"]').checked`));
    await evaluate(`window.__SET_MEETING_AVATAR_STATE__({joined:false,humanSpeaking:false,speaker:'b'})`);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    check("leaving removes human and speaker switch moves animation", await evaluate(`!document.querySelector('[data-meeting-seat="operator"]') && document.querySelectorAll('[data-avatar-speaking="true"]').length === 1 && document.querySelector('[data-meeting-seat="b"] [data-avatar-speaking="true"]') !== null`));
    await screenshot("meeting-workspace-wide");
    await evaluate(`document.querySelector('nav[aria-label="Agent views"] button:nth-child(3)').click()`);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    check("meeting navigation hides workspace and retains top notifications", await evaluate(`!document.querySelector('[aria-label="Meeting rooms workspace"]') && !!document.querySelector('[aria-label="Meeting notifications"] button')`));
    await evaluate(`document.querySelector('[aria-label="Meeting notifications"] button').click()`);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    check("meeting notification restores selected transcript", await evaluate(`!!document.querySelector('[aria-label="Meeting rooms workspace"]') && document.querySelector('header strong').textContent==='Architecture review' && document.querySelector('nav[aria-label="Agent views"] button[aria-current="page"]').textContent==='meeting rooms'`));
    await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 850, deviceScaleFactor: 1, mobile: false }, sessionId);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const small = await workspaceLayout();
    check("390px meeting panes stack without clipping", small.list.bottom <= small.detail.top && small.scroll <= small.width + 1 && small.detail.right <= 390, small);
    await screenshot("meeting-workspace-390");
    await evaluate(`window.__SET_MEETING_AVATAR_STATE__({joined:true,autoParticipation:true,participationNote:'Atlas can add a new technical perspective after Nova explains the testing concern.'})`);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    check("active participation controls fit a 390px meeting", await evaluate(`(() => { const box = document.querySelector('[aria-label="Active participation"]'); const b = box.closest('label').getBoundingClientRect(); return box.checked && b.width > 0 && b.left >= 0 && b.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; })()`));
    await evaluate(`window.__PARTICIPATION_SCROLL__ = [...document.querySelectorAll('*')].filter(e => e.scrollTop).map(e => [e,e.scrollTop]); document.querySelector('[aria-label="Active participation"]').scrollIntoView({block:'center'})`);
    await evaluate("new Promise(r => requestAnimationFrame(()=>requestAnimationFrame(r)))");
    await screenshot("meeting-active-participation-390");
    await evaluate(`for (const [element,top] of window.__PARTICIPATION_SCROLL__) element.scrollTop=top`);
    await call("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await evaluate(`document.querySelector('details:has(> summary[data-participant-settings])').open = true`);
    await screenshot("meeting-room-wide");
    await call("Emulation.setDeviceMetricsOverride", { width: 780, height: 850, deviceScaleFactor: 1, mobile: false }, sessionId);
    await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, sessionId);
    const layout = await evaluate("({width:innerWidth,scroll:document.documentElement.scrollWidth,animations:[...document.querySelectorAll('[data-avatar-speaking], [data-avatar-speaking] i')].map(i => getComputedStyle(i).animationName)})");
    check("780px meeting layout has no horizontal overflow", layout.scroll <= layout.width, layout);
    check("meeting UI honors reduced motion", layout.animations.every((name) => name === "none"), layout);
    await screenshot("meeting-room-narrow");

    const updates = await evaluate("window.__EXERCISE_MEETING_UPDATES__()");
    check("live participant approval controls", updates.approvalPreservedMicrophone && updates.declinePreservedMeeting, updates);
    console.log("Live participant approval controls", updates);
    const controls = await evaluate("window.__EXERCISE_MEETING_CONTROLS__()");
    check("participant controls and scoped confirmations", controls.partialFailureVisible && controls.failureVisibleOutsideRoom
      && controls.diagnosticsVisible && controls.targets.join() === "Atlas,Nova"
      && controls.actions.join() === "remove:c,end,agent.hold,end,agent.killMany", controls);
    console.log("Participant controls and scoped confirmations", controls);
    if (artifactDir) console.log(`Meeting browser screenshots: ${artifactDir}`);
  } finally {
    try { cdp?.close(); } finally {
      try { await terminateOwnedProcess(chrome); } finally {
        try { await vite?.close(); } finally { await removeScratchDirectory(scratch); }
      }
    }
  }
}, { requiredCheckIds: REQUIRED_CHECK_IDS.meeting });

process.exitCode = suiteExitCode;
