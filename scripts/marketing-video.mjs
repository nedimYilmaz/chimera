// Short usage videos of the REAL Chimera UI, for the README / GitHub Pages launch page.
//
// The same stand-in as scripts/marketing-preview.mjs: the real React screens on the real app store in
// local headless Chromium, answered by a mocked RPC bridge with the fictional "Atlas website" data. No
// daemon, provider, account, network or agent is involved the desktop target is a synthetic fixture SVG. The
// difference is the clock: this script drives scripted pointer movement, clicks and typing through
// CDP, makes the queue change state through the real store event path, and films the result at a FIXED
// frame rate (video time = frame index / fps), so a recapture of the same tree produces the same
// scripted scenes. Rasterization can vary; representative decoded hashes are recorded. A fixed-rate, scripted timeline is not a performance measurement and says nothing about how
// fast a live daemon is.
//
//   node scripts/marketing-video.mjs --serve     # print the capture shell URL and keep serving
//   node scripts/marketing-video.mjs --capture   # write site/assets/videos/* + provenance.{json,md}
//
// Options: --clip=<id> (repeatable; provenance.{json,md} are only rewritten by a run without --clip),
// --out=<dir> (default site/assets/videos), --no-mp4, --frames=<dir> (debug: keep the unique frames).
// Chromium comes from CHIMERA_TEST_CHROME or the gate's discovery and is never downloaded.
//
// Adding a clip: add an entry to CLIPS with a `run(rec)` that only uses the Recorder verbs (caption /
// click / type / press / hold / transition). Every verb that changes the UI is followed by an `expect`
// on the DOM, so a scene that did not happen fails the capture instead of being filmed. All data stays
// fictional; its generation and capture provenance is recorded alongside the films.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectCdp,
  createScratchDirectory,
  installLoopbackGuard,
  launchChromium,
  removeScratchDirectory,
  terminateOwnedProcess,
} from "./browser-gate.mjs";
import { FRAME, FROZEN_CLOCK_SCRIPT, startFixtureServer } from "./marketing-video-fixture.mjs";
import { buildMp4Tool, decodedFrameHashes, encodeMp4, encodeWebm, probeMp4, probeWithFfmpeg, resolveFfmpeg } from "./marketing-video-encode.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const serveOnly = flag("serve");
const preflight = flag("preflight");
const outDir = resolve(repoRoot, option("out")[0] ?? "site/assets/videos");
const framesDir = option("frames")[0] ? resolve(repoRoot, option("frames")[0]) : null;
const wantedClips = option("clip");

if (!serveOnly && !flag("capture") && !preflight) {
  console.error("usage: node scripts/marketing-video.mjs --capture [--clip=<id>] [--out=<dir>] [--no-mp4] [--frames=<dir>] | --serve");
  process.exit(2);
}

const FPS = 15;
// Pinned so every timestamp the fixtures mint and every "3m ago" the UI prints is identical per capture.
const FROZEN_AT = "2026-01-12T09:30:00.000Z";
const git = (...a) => execFileSync("git", ["-C", repoRoot, ...a], { encoding: "utf8" }).trim();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const q = JSON.stringify;
const clock = (seconds) => {
  const ms = Math.round(seconds * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
};

// What the viewer is told is real and what is scripted - copied into provenance and the storyboard.
const FIXTURE_VS_REAL = {
  real: [
    "The production React components: TopBar, Teams, Roles, Queues/Schedules, Settings/MCP/Secrets, Memory, agent inspector/ContextLinks/Resources, Projects/Canvas, ComputerUseMonitor and Footer on the production app store/reducer",
    "Every click, keystroke and focus change is a real input event dispatched into that UI through the browser's DevTools protocol",
    "Queue and memory screens refetch through their own coordination-event refresh path",
  ],
  scripted: [
    "The daemon: a scripted fixture answers every RPC; nothing is spawned, scheduled or executed",
    "Task state changes (pending, in progress, done) are replayed by the script; no worker ran the task",
    "All data is fictional: the Atlas website demo project, /demo paths and invented note text",
    "Visual treatment: captions/cursor overlay, production animations settled; deterministic eased camera, kinetic titles/captions and pointer/click overlays; measured fixture RTT hidden",
    "Desktop target: a synthetic SVG drawn by marketing-features.ts inside the real monitor; its lease and action history are scripted, no desktop was captured or controlled",
    "Timing: the film is sampled at a fixed 15 frames per second, so durations here are not response times",
  ],
};

// Pin the complete source snapshot used by this process, including current product components.
const PRODUCT_BASE = git("rev-parse", "HEAD");
const PRODUCT_TREE = git("rev-parse", "HEAD^{tree}");
if (!serveOnly && !preflight && git("status", "--porcelain")) throw new Error("Final capture requires a clean committed source tree; use --out outside the repository for combined screenshot/video captures.");
const CLIPS = [
  {
    id: "team-worker-overview", title: "See who is on the team", subtitle: "Team queue, roles and live workers", scenario: "inspect the Atlas team and one worker",
    async run(rec) {
      await rec.title(this.title, this.subtitle, 2.6);
      await rec.caption("1 · Open Teams"); await rec.click('[data-topbar-tab="teams"]');
      await rec.expect(`document.querySelector('[data-team-row="atlas"]')`, "team list"); await rec.hold(2);
      await rec.caption("2 · Select atlas: its queue and roles"); await rec.click('[data-team-row="atlas-docs"]'); await rec.click('[data-team-row="atlas"]');
      await rec.expect(`document.querySelector('[data-team-agent-table]')`, "team workers"); await rec.hold(3);
      await rec.caption("3 · Inspect a worker in the team");
      const worker = await rec.evaluate(`document.querySelectorAll('[data-team-agent]')[1]?.dataset.teamAgent`);
      await rec.reveal(`[data-team-agent="${worker}"]`); await rec.click(`[data-team-agent="${worker}"]`);
      await rec.expect(`document.querySelector('[data-agent-inspector]')`, "worker inspector");
      await rec.reveal('[data-agent-inspector]'); await rec.focus('[data-agent-inspector]', 1.2); await rec.poster(true); await rec.hold(4);
      await rec.resetCamera(); await rec.hold(2);
    }
  },
  {
    id: "role-library-binding", title: "Inspect a reusable role", subtitle: "Library settings and team bindings", scenario: "compare a library role with its Atlas team binding",
    async run(rec) {
      await rec.title(this.title, this.subtitle, 2.6);
      await rec.caption("1 · Open the role library"); await rec.click('[data-tab-overflow]'); await rec.click('[data-topbar-overflow-tab="roles"]');
      await rec.expect(`document.querySelector('[data-role-row="builder"]')`, "library role"); await rec.hold(2);
      await rec.caption("2 · Select builder and inspect its settings"); await rec.click('[data-role-row="builder"]');
      await rec.expect(`document.querySelector('[data-spawn-with-role]')`, "role details"); await rec.hold(3);
      await rec.caption("3 · Inspect the team's builder binding"); await rec.reveal('[data-role-row="atlas/builder"]'); await rec.click('[data-role-row="atlas/builder"]');
      await rec.expect(`document.querySelector('[data-team-role-remove]')`, "team role details");
      await rec.focus('[data-team-role-remove]', 1.15); await rec.poster(true); await rec.hold(4);
      await rec.resetCamera(); await rec.hold(2);
    }
  },
  {
    id: "schedule-run-history", title: "Trace a scheduled run", subtitle: "Schedule targets and run history", scenario: "inspect the Atlas accessibility schedule and filter run history",
    async run(rec) {
      await rec.title(this.title, this.subtitle, 2.6);
      await rec.caption("1 · Open queues and schedules"); await rec.click('[data-topbar-tab="queues"]');
      await rec.expect(`document.querySelector('[data-job-row="atlas-a11y-sweep"]')`, "schedule list"); await rec.hold(2);
      await rec.caption("2 · Select the accessibility sweep"); await rec.reveal('[data-job-row="atlas-a11y-sweep"]'); await rec.click('[data-job-row="atlas-a11y-sweep"]');
      await rec.expect(`document.querySelector('[aria-label="search run history"]')`, "run history"); await rec.hold(3);
      await rec.caption("3 · Find the failed preview run"); await rec.click('[aria-label="search run history"]'); await rec.type("504", 3);
      await rec.expect(`document.body.innerText.includes('HTTP 504')`, "failed run visible");
      await rec.focus('[aria-label="search run history"]', 1.2); await rec.poster(true); await rec.hold(4);
      await rec.resetCamera(); await rec.hold(2);
    }
  },
  {
    id: "mcp-tool-inspection", title: "Inspect a connected tool server", subtitle: "MCP server status and available tools", scenario: "open the fictional Atlas docs server tool list",
    async run(rec) {
      await rec.title(this.title, this.subtitle, 2.6);
      await rec.caption("1 · Open Settings"); await rec.click('[data-tab-overflow]'); await rec.click('[data-topbar-overflow-tab="settings"]');
      await rec.expect(`document.querySelector('[data-settings-section="mcp"]')`, "settings rail"); await rec.click('[data-settings-section="mcp"]');
      await rec.expect(`document.querySelector('[data-mcp-store-expand="atlas-docs"]')`, "MCP store"); await rec.hold(2);
      await rec.caption("2 · Inspect the Atlas docs server"); await rec.reveal('[data-mcp-store-expand="atlas-docs"]'); await rec.click('[data-mcp-store-expand="atlas-docs"]');
      await rec.expect(`document.querySelector('[data-mcp-store-tools="atlas-docs"]')?.innerText.includes('docs')`, "tools loaded"); await rec.hold(3);
      await rec.caption("3 · Read the tools before using them"); await rec.focus('[data-mcp-store-tools="atlas-docs"]', 1.2);
      await rec.poster(true); await rec.hold(4); await rec.resetCamera(); await rec.hold(3);
    }
  },
  {
    id: "secret-access-inspection", title: "Inspect secret access", subtitle: "Named secrets and explicit agent grants", scenario: "search fictional secret metadata and inspect access controls without revealing values",
    async run(rec) {
      await rec.title(this.title, this.subtitle, 2.6);
      await rec.caption("1 · Open the secret store");
      await rec.click('[data-tab-overflow]'); await rec.click('[data-topbar-overflow-tab="settings"]'); await rec.expect(`document.querySelector('[data-settings-section="secrets"]')`, "settings rail"); await rec.click('[data-settings-section="secrets"]');
      await rec.expect(`document.querySelector('[data-secret-row]')`, "secret metadata"); await rec.hold(2);
      await rec.caption("2 · Find the staging token by name"); await rec.click('[placeholder="Search name or description"]'); await rec.type("STAGING", 3);
      await rec.expect(`document.querySelectorAll('[data-secret-row]').length === 1`, "search filtered"); await rec.hold(3);
      await rec.caption("3 · Inspect its explicit access controls"); await rec.click('[data-secret-row] summary');
      await rec.expect(`document.querySelector('[data-secret-row] details').open`, "access controls open");
      await rec.focus('[data-secret-row]', 1.15); await rec.poster(true); await rec.hold(4);
      await rec.resetCamera(); await rec.hold(2);
    }
  },

  {
    id: "team-queue-lifecycle",
    title: "Put the next task in motion",
    subtitle: "Teams and queues: pushing a task, then pending → in progress → done",
    scenario: "team/queue lifecycle on the Atlas release queue",
    async run(rec) {
      await rec.title("Put the next task in motion", "Teams & queues in the real Chimera UI", 2.6);
      await rec.cursorOn(900, 560);
      await rec.caption("Workspace: the conductor and its team of agents");
      await rec.expect(`document.querySelectorAll('[data-agent-row]').length >= 3`, "agent rows");
      await rec.poster(false);
      await rec.hold(1.6);

      await rec.caption("1 · Open the Queues tab");
      await rec.click(`[data-topbar-tab="queues"]`);
      await rec.expect(`document.querySelector('[data-topbar-tab="queues"]')?.getAttribute('aria-current') === 'page' && document.querySelectorAll('[data-queue-row]').length >= 2`, "queues tab");
      await rec.hold(1.4);

      await rec.caption("2 · Open the atlas-release queue");
      await rec.click(`[data-queue-row="atlas-release"]`);
      await rec.expect(`document.querySelectorAll('[data-task-row]').length >= 10`, "release queue tasks");
      await rec.measureUi(`[data-task-row]`);
      await rec.focus(`[data-task-row]`, 1.35);
      await rec.hold(2.0);

      await rec.caption("3 · Select a task, then choose “new”");
      // Row 0 is already the cursor row, and clicking it only toggles its detail pane closed.
      const secondTask = await rec.evaluate(`document.querySelectorAll('[data-task-row]')[1]?.dataset.taskRow`);
      if (!secondTask) throw new Error('queue has no second task');
      await rec.click(`[data-task-row="${secondTask}"]`);
      await rec.hold(0.8);
      await rec.resetCamera();
      await rec.click({ selector: `[data-action-chip]`, text: "new" });
      await rec.expect(`document.body.innerText.includes('push task') && document.activeElement?.dataset?.field === 'prompt'`, "push form focused on prompt");
      await rec.hold(1.0);

      await rec.caption("4 · Type the task; Enter moves through fields");
      await rec.type("Compress hero images to WebP", 1);
      await rec.expect(`document.querySelector('[data-field="prompt"]')?.value === 'Compress hero images to WebP'`, "prompt typed");
      await rec.press("Enter", 6);
      await rec.expect(`document.activeElement?.dataset?.field === 'priority'`, "priority field focused");
      await rec.press("Enter", 6);
      await rec.expect(`document.activeElement?.dataset?.field === 'role'`, "role field focused");
      await rec.press("Enter", 6);
      await rec.expect(`document.activeElement?.dataset?.field === 'workflow'`, "workflow field focused");
      await rec.press("Enter", 6);
      await rec.expect(`document.activeElement?.dataset?.field === 'tags'`, "tags field focused");
      await rec.type("gate:visual", 2);
      await rec.expect(`document.querySelector('[data-field="tags"]')?.value === 'gate:visual'`, "tag typed");
      await rec.hold(1.0);

      await rec.caption("5 · Push the task: pending");
      await rec.press("Enter", 4);
      await rec.expect(`!document.body.innerText.includes('push task') && document.querySelector('[data-task-row="d1e5a7c3"]') !== null`, "pushed task row");
      await rec.transition("d1e5a7c3", "pending");
      await rec.reveal(`[data-task-row="d1e5a7c3"]`);
      await rec.expect(`/pending/.test(document.querySelector('[data-task-row="d1e5a7c3"]')?.innerText ?? '')`, "task pending");
      await rec.hold(1.6);

      await rec.caption("6 · The task is in progress");
      await rec.transition("d1e5a7c3", "in_progress");
      await rec.expect(`/in.progress/.test(document.querySelector('[data-task-row="d1e5a7c3"]')?.innerText ?? '')`, "task in progress");
      await rec.hold(2.4);

      await rec.caption("7 · The task finishes: done, counts update");
      await rec.transition("d1e5a7c3", "done");
      await rec.expect(`/\\bdone\\b/.test(document.querySelector('[data-task-row="d1e5a7c3"]')?.innerText ?? '')`, "task done");
      await rec.focus('[data-task-row="d1e5a7c3"]', 1.55);
      await rec.poster(true);
      await rec.hold(2.6);

      await rec.caption("Follow a task from pending to done");
      await rec.hold(2.6);
    },
  },
  {
    id: "memory-search-link",
    title: "Search → open → follow a linked note",
    subtitle: "Memory: search the shared notes, open a hit, follow its link",
    scenario: "memory search, open a note, follow a [[link]] and see the backlink",
    async run(rec) {
      await rec.title("Search → open → follow a linked note", "Shared memory in the real Chimera UI", 2.6);
      await rec.cursorOn(900, 560);
      await rec.caption("Agents keep shared notes in Memory");
      await rec.expect(`document.querySelectorAll('[data-agent-row]').length >= 3`, "workspace");
      await rec.hold(1.8);

      await rec.caption("1 · Open the Memory tab");
      if (!await rec.evaluate(`Boolean(document.querySelector('[data-topbar-tab="memory"]'))`)) {
        await rec.click('[data-tab-overflow]');
        await rec.expect(`document.querySelector('[data-topbar-overflow-tab="memory"]') !== null`, "memory overflow entry");
        await rec.click('[data-topbar-overflow-tab="memory"]');
      } else await rec.click('[data-topbar-tab="memory"]');
      await rec.expect(`document.querySelector('[data-topbar-tab="memory"]')?.getAttribute('aria-current') === 'page' && document.querySelectorAll('[data-memory-row]').length >= 12`, "all notes listed");
      await rec.measureUi(`[data-memory-row]`);
      await rec.hold(1.8);

      await rec.caption("2 · Search the notes for “webp”");
      await rec.click(`[data-memory-search]`);
      await rec.type("webp");
      await rec.expect(`(() => { const ids = [...document.querySelectorAll('[data-memory-row]')].map((r) => r.dataset.memoryRow).sort(); return ids.join() === 'm-0007,m-0008'; })()`, "only the two webp notes remain");
      await rec.hold(2.0);

      await rec.caption("3 · Open a note and read its links");
      // The first hit is the cursor row (its detail is already open); open the other one explicitly.
      const first = await rec.evaluate(`document.querySelector('[data-memory-row]')?.dataset.memoryRow`);
      const second = first === "m-0007" ? "m-0008" : "m-0007";
      await rec.click(`[data-memory-row="${second}"]`);
      const openedTitle = second === "m-0007" ? "Ship WebP hero first, AVIF as follow-up" : "Image pipeline notes";
      await rec.expect(`document.querySelector('[class*="detailTitle_"]')?.textContent === ${q(openedTitle)} && document.querySelector('[data-memory-link]') !== null`, "opened note title and links");
      await rec.hold(1.6);

      await rec.caption("4 · Follow the link to the connected note");
      const link = await rec.evaluate(`document.querySelector('[data-memory-link][role="button"]')?.dataset.memoryLink ?? null`);
      if (!link) throw new Error("the opened note has no resolvable link to follow");
      const linkedTitle = await rec.evaluate(`window.__MARKETING_RPC__('memory.get', {id: ${q(link)}}).record.title`);
      await rec.click(`[data-memory-link="${link}"]`);
      await rec.expect(`document.querySelector('[class*="detailTitle_"]')?.textContent === ${q(linkedTitle)} && document.querySelector('[data-memory-backlink="${second}"]') !== null`, "linked note title and backlink");
      await rec.focus('[class*="detailTitle_"]', 1.55);
      await rec.poster(true);
      await rec.hold(2.6);

      await rec.caption("The note links back: backlinks are listed too");
      await rec.resetCamera();
      await rec.reveal('[data-memory-backlink]');
      await rec.focus('[data-memory-backlink]', 1.45);
      await rec.visible('[data-memory-backlink]', 'backlink visible');
      await rec.hold(2.6);
    },
  },
  {
    id: "context-handoff", title: "Share just the context they need", subtitle: "Explicit snapshots: share, read, revoke", scenario: "explicit context snapshot and revocation; scripted RPC only",
    async run(rec) {
      await rec.title("Share just the context they need", "One reviewed snapshot. One explicit recipient.", 2);
      await rec.cursorOn(880, 480);
      await rec.caption("1 · Open the agent inspector");
      await rec.click('[data-agent-detail-toggle]');
      await rec.expect(`document.querySelector('[data-context-links]')`, "context controls mounted");
      await rec.click('[data-context-links] summary');
      await rec.expect(`document.body.innerText.includes('No shared context snapshots')`, "empty context list");
      await rec.hold(1);
      await rec.caption("2 · Choose an explicit snapshot");
      await rec.click('[data-context-add]');
      await rec.expect(`document.querySelector('[data-context-share]')`, "share form");
      await rec.focus('[data-context-share]', 1.25);
      await rec.hold(2.4);
      await rec.click('[data-context-share-submit]');
      await rec.expect(`document.body.innerText.includes('Snapshot shared.')`, "snapshot shared");
      await rec.hold(1.6);
      await rec.resetCamera();
      await rec.click({selector:'[data-context-share] button, [role="dialog"] button',text:'Cancel'});
      await rec.click('[data-context-refresh]');
      await rec.expect(`document.querySelector('[data-context-read]')`, "shared entry");
      await rec.caption("3 · Pull the snapshot explicitly");
      await rec.click('[data-context-read]');
      await rec.expect(`document.querySelector('[data-context-body]')?.innerText.includes('Atlas release:')`, "exact snapshot body");
      await rec.reveal('[data-context-body]');
      await rec.focus('[data-context-body]', 1.45);
      await rec.visible('[data-context-body]', 'snapshot body visible');
      await rec.poster(true); await rec.hold(3);
      await rec.caption("4 · Revoke future reads");
      await rec.resetCamera();
      await rec.click('[data-context-revoke]');
      await rec.expect(`document.querySelector('[data-context-read]')?.disabled && !document.querySelector('[data-context-body]')`, "revoked body unavailable");
      await rec.focus('[data-context-links]', 1.4); await rec.hold(3);
    }
  },
  {
    id: "resource-diagnostics", title: "See why new agents are waiting", subtitle: "OS resources and admission capacity", scenario: "read-only resource attribution and capped admission; fictional metrics",
    async run(rec) {
      await rec.title("See why new agents are waiting", "Inspect the process. Understand the capacity.", 2);
      await rec.cursorOn(890, 510);
      await rec.caption("1 · Open the agent inspector");
      await rec.click('[data-agent-detail-toggle]');
      await rec.expect(`document.querySelector('[data-agent-resources]')`, "resources disclosure"); await rec.hold(1.5);
      await rec.caption("2 · Inspect OS memory and CPU");
      await rec.click('[data-agent-resources] summary');
      await rec.expect(`document.querySelector('[data-resource-tree]') && document.body.innerText.includes('232.0 MiB RSS')`, "validated resource snapshot");
      await rec.reveal('[data-resource-tree] > div');
      await rec.focus('[data-resource-tree] > div', 1.6);
      await rec.visible('[data-resource-tree] > div', 'process rows visible'); await rec.poster(true); await rec.hold(4);
      await rec.caption("RSS is separate from token context"); await rec.hold(3);
      await rec.caption("3 · At capacity: new agents wait");
      await rec.resetCamera();
      await rec.reveal('[data-host-admission] + div');
      await rec.focus('[data-host-admission]', 1.85, 'start');
      await rec.visible('[data-host-admission] + div', 'capacity explanation visible');
      await rec.expect(`document.body.innerText.includes('new agents wait for capacity')`, "capacity explanation"); await rec.hold(4);
    }
  },
  {
    id: "project-canvas", title: "Find the relationships behind the work", subtitle: "Projects: List and Canvas", scenario: "existing project entities in Canvas; synthetic relationship metadata",
    async run(rec) {
      await rec.title("Find the relationships behind the work", "A project view of agents, tasks and shared context.", 2);
      await rec.cursorOn(890, 510);
      await rec.caption("1 · Open the Atlas project");
      await rec.click('[data-topbar-tab="projects"]');
      await rec.expect(`document.querySelector('[data-project-row="atlas-website"]')`, "project list");
      await rec.expect(`document.querySelector('[data-project-canvas-toggle]')`, "project view controls"); await rec.hold(1.2);
      await rec.caption("2 · Switch from List to Canvas");
      await rec.click('[data-project-canvas-toggle]');
      await rec.expect(`document.querySelector('[data-canvas-node]')`, "real Canvas nodes");
      await rec.focus('[data-canvas-surface]', 1.15); await rec.hold(3);
      await rec.caption("3 · Select an existing agent");
      await rec.click('[data-canvas-node="agent:atlas-builder"]');
      await rec.expect(`document.querySelector('[data-canvas-selection="agent:atlas-builder"]')`, "selected entity");
      await rec.poster(true); await rec.hold(3);
      await rec.resetCamera();
      await rec.caption("4 · Filter the included entities");
      await rec.click('input[aria-label="Filter included canvas entities"]'); await rec.type('snapshot', 2);
      await rec.expect(`document.querySelector('[data-canvas-filter-count]')?.innerText.includes('1 of 4')`, "filtered snapshot"); await rec.hold(2.2);
      await rec.caption("5 · Return to the accessible List");
      await rec.click('[data-project-list]');
      await rec.expect(`document.querySelector('[data-canvas-list]')`, "graph List"); await rec.hold(2.6);
    }
  },
  {
    id: "desktop-preview", title: "Keep desktop control in view", subtitle: "Preview ownership and action history", scenario: "real desktop monitor with synthetic target; no real desktop control",
    async run(rec) {
      await rec.title("Keep desktop control in view", "Preview ownership and recent actions.", 2);
      await rec.evaluate(`window.__MARKETING__.show('computer-use')`);
      await rec.expect(`document.querySelector('[data-computer-monitor]')`, "desktop monitor");
      await rec.cursorOn(880, 440);
      await rec.caption("1 · See the desktop control owner");
      const initiallyOpen = await rec.evaluate(`Boolean(document.querySelector('[aria-label="Collapse desktop preview"]'))`);
      if (initiallyOpen) await rec.click('[aria-label="Collapse desktop preview"]');
      await rec.hold(3);
      await rec.caption("2 · Expand the desktop preview");
      const collapsed = await rec.evaluate(`Boolean(document.querySelector('[aria-label="Expand desktop preview"]'))`);
      if (collapsed) await rec.click('[aria-label="Expand desktop preview"]');
      await rec.expect(`document.querySelector('[data-computer-monitor] img')`, "synthetic preview image");
      await rec.focus('[data-computer-monitor]', 1.55); await rec.poster(true); await rec.hold(4);
      await rec.reveal('[data-action-state]');
      await rec.visible('[data-action-state]', 'recent action visible');
      await rec.caption("Review recent desktop actions");
      await rec.expect(`document.querySelector('[data-action-state]')`, "action history"); await rec.hold(4);
      await rec.caption("3 · Collapse to keep the workspace clear");
      await rec.click('[aria-label="Collapse desktop preview"]');
      await rec.expect(`document.querySelector('[data-computer-monitor]')?.dataset.mode === 'collapsed'`, "collapsed preview");
      await rec.resetCamera(); await rec.hold(3);
    }
  },
];

const selected = CLIPS.filter((clip) => wantedClips.length === 0 || wantedClips.includes(clip.id));
if (selected.length === 0) {
  console.error(`no clip matches ${wantedClips.join(", ")}; known: ${CLIPS.map((c) => c.id).join(", ")}`);
  process.exit(2);
}

const scratch = createScratchDirectory("chimera-marketing-video-");
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

let fixture;
let chrome;
let cdp;
try {
  fixture = await startFixtureServer({ repoRoot, scratch });
  if (serveOnly) {
    console.log(`Capture shell: ${fixture.url}?view=workspace  (Ctrl-C to stop)`);
    await new Promise((resolveStop) => controller.signal.addEventListener("abort", resolveStop));
    await fixture.close();
    await removeScratchDirectory(scratch);
    process.exit(0);
  }

  const launched = await launchChromium({
    signal: controller.signal,
    args: [
      "--headless=new", "--mute-audio", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--force-color-profile=srgb", "--disable-smooth-scrolling", "--disable-gpu", "--disable-lcd-text", "--disable-font-subpixel-positioning", "--num-raster-threads=1", "--disable-skia-runtime-opts", "--run-all-compositor-stages-before-draw", "--remote-debugging-port=0",
      `--user-data-dir=${join(scratch, "chrome")}`, "about:blank",
    ],
  });
  chrome = launched.child;
  cdp = await connectCdp(launched.endpoint, { signal: controller.signal });
  const { targetId } = await cdp.call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params = {}) => cdp.call(method, params, sessionId);
  await call("Page.enable");
  await call("Runtime.enable");
  await installLoopbackGuard(cdp, sessionId, `http://127.0.0.1:${fixture.port}`);
  await call("Page.addScriptToEvaluateOnNewDocument", { source: FROZEN_CLOCK_SCRIPT(FROZEN_AT) });
  const browserVersion = (await cdp.call("Browser.getVersion")).product;

  const exceptions = [];
  cdp.onEvent((message) => {
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(JSON.stringify(message.params).slice(0, 600));
      console.error("Browser exception:", exceptions.at(-1));
    }
  });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(`evaluate failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  };
  const frames2 = () => evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  const waitFor = async (expression, label, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`).catch(() => false)) return;
      await new Promise((r) => setTimeout(r, 60));
    }
    const shot = await call("Page.captureScreenshot", { format: "png" }).catch(() => null);
    // Outside outDir on purpose: a debug frame must never end up in the published directory.
    if (shot) writeFileSync(join(tmpdir(), `chimera-marketing-video-debug-${label.replace(/\W+/g, "-")}.png`), Buffer.from(shot.data, "base64"));
    const text = await evaluate("document.body.innerText.slice(0, 400)").catch(() => "?");
    throw new Error(`timed out waiting for ${label}\n  condition: ${expression}\n  rendered: ${JSON.stringify(text)}`);
  };

  await call("Emulation.setDeviceMetricsOverride", { width: FRAME.width, height: FRAME.height, deviceScaleFactor: 1, mobile: false });
  await call("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await waitFor(`innerWidth === ${FRAME.width} && innerHeight === ${FRAME.height}`, "viewport");

  const locate = (target) => {
    const { selector, text } = typeof target === "string" ? { selector: target, text: null } : target;
    return `[...document.querySelectorAll(${q(selector)})].find((el) => ${text ? `el.textContent.trim().endsWith(${q(text)})` : "true"})`;
  };

  class Recorder {
    constructor(clip) {
      this.clip = clip;
      this.dir = join(scratch, "frames");
      mkdirSync(this.dir, { recursive: true });
      this.entries = []; // [{ path, sha, count }] - consecutive identical frames merged
      this.total = 0;
      this.cues = [];
      this.open = null;
      this.steps = [];
      this.posters = [];
      this.pointer = { x: 900, y: 560 };
      this.uiFontPx = null;
      this.camera = { x: 0, y: 0, scale: 1 };
      this.motion = [];
      this.evaluate = evaluate;
    }

    get seconds() { return this.total / FPS; }

    /** One settled capture, shown for `count` frames. The settle also checks caption geometry and the presentation contract. */
    async snap(count = 1) {
      if (preflight) { this.total += count; return { path: null, sha: null }; }
      const settled = await evaluate(`document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const caption = document.getElementById('mv-caption');
        const stage = document.getElementById('mv-stage');
        resolve({ captionHeight: caption.getBoundingClientRect().height, stageTop: stage.getBoundingClientRect().top, repeatedLabel: Boolean(document.querySelector('#mv-band, .mv-tag')) });
      }))))`);
      if (settled.repeatedLabel || settled.captionHeight !== FRAME.caption || settled.stageTop !== FRAME.caption) throw new Error(`frame ${this.total}: invalid caption or stage geometry`);
      const shot = await call("Page.captureScreenshot", { format: "jpeg", quality: 95, optimizeForSpeed: false });
      const bytes = Buffer.from(shot.data, "base64");
      const sha = sha256(bytes);
      const path = join(this.dir, `${sha.slice(0, 20)}.jpg`);
      if (!existsSync(path)) writeFileSync(path, bytes);
      const last = this.entries.at(-1);
      if (last && last.sha === sha) last.count += count;
      else this.entries.push({ path, sha, count });
      this.total += count;
      return { path, sha };
    }

    hold(seconds) { return this.snap(Math.max(1, Math.round(seconds * FPS))); }

    async expect(expression, label) {
      await waitFor(expression, `${this.clip.id}: ${label}`);
      await frames2();
    }

    async visible(selector, label) {
      await this.expect(`(() => { const el=document.querySelector(${q(selector)}); if (!el) return false; const r=el.getBoundingClientRect(); let top=Math.max(r.top,${FRAME.caption}),bottom=Math.min(r.bottom,${FRAME.height}); for(let p=el.parentElement;p;p=p.parentElement) {if(/auto|scroll|hidden/.test(getComputedStyle(p).overflowY)) { const a=p.getBoundingClientRect(); top=Math.max(top,a.top);bottom=Math.min(bottom,a.bottom); }} return bottom-top >= r.height*.7; })()`, label);
    }
    async tween(frames, render) {
      for (let i = 1; i <= frames; i++) { const t = i / frames; await render(t * t * (3 - 2 * t)); await this.snap(); }
    }
    async cameraTo(next) {
      const previous = this.camera;
      this.motion.push({ atSeconds: this.seconds, ...next });
      await this.tween(10, e => evaluate(`document.getElementById('root').style.transform = 'translate(${previous.x + (next.x-previous.x)*e}px,${previous.y + (next.y-previous.y)*e}px) scale(${previous.scale + (next.scale-previous.scale)*e})'`));
      this.camera = next;
    }
    async resetCamera() { if (this.camera.scale !== 1) await this.cameraTo({ x:0, y:0, scale:1 }); }
    async focus(target, scale = 1.5, align = "center") {
      await this.resetCamera();
      const rect = await evaluate(`(() => { const el = ${locate(target)}; if (!el) throw new Error('focus target missing'); const r=el.getBoundingClientRect(); return {x:r.x+${align === "start" ? "Math.min(r.width/2,200)" : "r.width/2"},y:r.y+r.height/2-${FRAME.caption}}; })()`);
      const height = FRAME.height-FRAME.caption;
      await this.cameraTo({ scale, x: Math.max(FRAME.width*(1-scale), Math.min(0,FRAME.width/2-rect.x*scale)), y: Math.max(height*(1-scale),Math.min(0,height/2-rect.y*scale)) });
    }
    async title(heading, sub, seconds) {
      await evaluate(`(() => { const t=document.getElementById('mv-title'); t.querySelector('h1').textContent=${q(heading)}; t.querySelector('p').textContent=${q(sub)}; t.setAttribute('data-on',''); })()`);
      await this.tween(9, e => evaluate(`(() => {const t=document.getElementById('mv-title'); t.style.opacity=${e};t.querySelector('h1').style.transform='translateY(${24*(1-e)}px)';})()`));
      if (heading === "Your agents. One workspace.") { await evaluate(`document.getElementById("mv-cursor").removeAttribute("data-on")`); await this.hold(seconds-.6); return; }
      await this.hold(Math.max(.4,seconds-1.2));
      await this.tween(9, e => evaluate(`document.getElementById('mv-title').style.opacity=${1-e}`));
      await evaluate(`document.getElementById('mv-title').removeAttribute('data-on')`);
    }

    async caption(text) {
      const shape = await evaluate(`(() => {
        const bar = document.getElementById('mv-caption');
        bar.textContent = ${q(text)};
        const range = document.createRange();
        range.selectNodeContents(bar);
        const rect = range.getBoundingClientRect();
        return { height: rect.height, lineHeight: parseFloat(getComputedStyle(bar).lineHeight), width: rect.width, bar: bar.clientWidth };
      })()`);
      if (shape.height > shape.lineHeight * 1.4 || shape.width > shape.bar - 40) throw new Error(`caption does not fit on one line: ${text}`);
      if (this.open) this.open.end = this.seconds;
      this.open = { start: this.seconds, end: null, text };
      this.cues.push(this.open);
      this.steps.push({ at: this.seconds, text });
      await this.tween(4, e => evaluate(`document.getElementById("mv-caption").style.transform="translateY(${8*(1-e)}px)"`));
    }

    cursorOn(x, y) {
      this.pointer = { x, y };
      return evaluate(`(() => { const c = document.getElementById('mv-cursor'); c.setAttribute('data-on', ''); c.style.transform = 'translate(${x}px, ${y}px)'; })()`);
    }

    async #pointerTo(x, y) {
      await evaluate(`document.getElementById('mv-cursor').style.transform = 'translate(${x}px, ${y}px)'`);
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      this.pointer = { x, y };
    }

    async glide(x, y) {
      const { x: x0, y: y0 } = this.pointer;
      const steps = Math.max(6, Math.min(12, Math.round(Math.hypot(x - x0, y - y0) / 40)));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const e = t * t * (3 - 2 * t); // smoothstep: ease in and out
        await this.#pointerTo(Math.round(x0 + (x - x0) * e), Math.round(y0 + (y - y0) * e));
        await this.snap(1);
      }
    }

    async click(target) {
      await evaluate(`(() => { const el = ${locate(target)}; if (!el) throw new Error('nothing matches ${q(target).replace(/'/g, "\\'")}'); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); })()`);
      await frames2();
      const spot = await evaluate(`(() => { const el = ${locate(target)}; const r = el.getBoundingClientRect(); const x = Math.round(r.left + Math.min(r.width / 2, 90)); const y = Math.round(r.top + r.height / 2); const hit = document.elementFromPoint(x, y); return { x, y, reachable: Boolean(hit && (hit === el || el.contains(hit))) }; })()`);
      if (!spot.reachable) throw new Error(`${q(target)} is not what is under the pointer at ${spot.x},${spot.y}`);
      await this.glide(spot.x, spot.y);
      await this.snap(3); // hover
      await evaluate(`document.getElementById('mv-cursor').setAttribute('data-down', '')`);
      await call("Input.dispatchMouseEvent", { type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: 1 });
      await this.tween(5, e => evaluate(`document.querySelector("#mv-cursor i").style.transform="scale(${.65+e*.9})"`));
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: 1 });
      await evaluate(`document.getElementById('mv-cursor').removeAttribute('data-down')`);
      await frames2();
    }

    async type(text, framesPerChar = 2) {
      for (const ch of text) {
        await call("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
        await call("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        await this.snap(framesPerChar);
      }
    }

    async press(key, framesAfter = 4) {
      const codes = { Enter: 13, Tab: 9, Escape: 27 };
      await call("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: codes[key], text: key === "Enter" ? "\r" : undefined });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: codes[key] });
      await this.snap(framesAfter);
    }

    /** Scrolls the nearest scrollable ancestor in a few eased steps until the element is fully visible. */
    async reveal(selector, steps = 6) {
      const plan = await evaluate(`(() => {
        const el = document.querySelector(${q(selector)});
        let p = el.parentElement;
        while (p && !(p.scrollHeight > p.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
        if (!p) return null;
        const pr = p.getBoundingClientRect(), er = el.getBoundingClientRect();
        let top=Math.max(pr.top,${FRAME.caption}), bottom=Math.min(pr.bottom,${FRAME.height});
        for(let a=p.parentElement;a;a=a.parentElement) { if(/auto|scroll|hidden/.test(getComputedStyle(a).overflowY)) {const r=a.getBoundingClientRect();top=Math.max(top,r.top);bottom=Math.min(bottom,r.bottom);} }
        const delta = er.bottom > bottom ? er.bottom - bottom + 12 : er.top < top ? er.top - top - 12 : 0;
        p.setAttribute('data-mv-scroll', '');
        return { delta, from: p.scrollTop };
      })()`);
      if (!plan || plan.delta === 0) return;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await evaluate(`document.querySelector('[data-mv-scroll]').scrollTop = ${plan.from + Math.round(plan.delta * t * t * (3 - 2 * t))}`);
        await this.snap(1);
      }
      await evaluate(`document.querySelector('[data-mv-scroll]')?.removeAttribute('data-mv-scroll')`);
    }

    /** Tells the real UI a queue task changed state (a `status` event on `task:<id>`), then lets it refetch. */
    async transition(taskId, state) {
      await evaluate(`window.__MARKETING_VIDEO__.transition(${q(taskId)}, ${q(state)})`);
      await frames2();
      await frames2();
    }

    /** Marks the NEXT captured frame as the poster candidate (`late`: use the latest mark, else the first). */
    async poster(late) {
      const { path, sha } = await this.snap(1);
      this.posters.push({ path, sha, late });
    }

    async measureUi(selector) {
      this.uiFontPx = await evaluate(`parseFloat(getComputedStyle(document.querySelector(${q(selector)})).fontSize)`);
    }
  }

  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) throw new Error("no ffmpeg found (set FFMPEG, put one on PATH, or install Playwright's browsers)");
  const ffmpegVersion = execFileSync(ffmpeg, ["-version"], { encoding: "utf8" }).split("\n")[0];
  const mp4Tool = preflight || flag("no-mp4") ? null : await buildMp4Tool({ scratch, signal: controller.signal });
  mkdirSync(outDir, { recursive: true });
  // An overwritten clip invalidates prior playback/reproducibility evidence.
  for (const report of preflight ? [] : ['verification.json', 'determinism.json']) rmSync(join(outDir, report), { force: true });

  const results = [];
  for (const clip of selected) {
    console.log(`\n▶ ${clip.id}`);
    exceptions.length = 0;
    await call("Page.navigate", { url: `${fixture.url}?view=workspace` });
    await waitFor(`window.__MARKETING__ && window.__MARKETING_VIDEO__ && document.body.dataset.marketingReady === 'workspace'`, `${clip.id}: workspace mounted`);
    await waitFor(`document.querySelectorAll('[data-agent-row]').length >= 3 && document.body.innerText.includes('Three gates are tagged on the queue')`, `${clip.id}: workspace data`);
    await waitFor(`document.querySelector('[data-resource-summary]')?.textContent.includes('CPU 15.5%') && document.querySelector('[data-resource-summary]')?.textContent.includes('RAM 232 MiB')`, `${clip.id}: compact header resources`);
    await frames2();
    await evaluate(`document.fonts.ready`);
    const headerFit = await evaluate(`(() => { const h = document.querySelector('[data-transcript-header]'), m = h.querySelector('[data-transcript-metrics]'), r = h.getBoundingClientRect(), b = m.getBoundingClientRect(); return { width: r.width, height: r.height, metricsWidth: b.width, withinHeader: b.left >= r.left && b.right <= r.right + 1, detailsClosed: !m.open, resourceText: h.querySelector('[data-resource-summary]').textContent }; })()`);
    if (!headerFit.withinHeader || !headerFit.detailsClosed) throw new Error(`${clip.id}: compact header does not fit or Details starts open`);

    const rec = new Recorder(clip);
    try {
      await clip.run(rec);
      await rec.title("Your agents. One workspace.", "Explore Chimera · source and setup on GitHub", 2);
    } catch (error) {
      // A scene that fails is the most useful thing to look at; keep the frame outside outDir.
      const shot = await call("Page.captureScreenshot", { format: "png" }).catch(() => null);
      if (shot) {
        const debug = join(tmpdir(), `chimera-marketing-video-debug-${clip.id}.png`);
        writeFileSync(debug, Buffer.from(shot.data, "base64"));
        console.error(`  scene failed at ${rec.seconds.toFixed(1)}s; page saved to ${debug}`);
      }
      throw error;
    }
    if (rec.open) rec.open.end = rec.seconds;

    const misses = await evaluate(`window.__MARKETING_VIDEO__.misses()`);
    if (misses.length > 0) throw new Error(`${clip.id}: the fixture had no answer for ${misses.join(", ")}`);
    if (exceptions.length > 0) throw new Error(`${clip.id}: the page threw ${exceptions.length} exception(s) while filming`);

    if (preflight) { console.log(`  assertions passed · ${rec.seconds.toFixed(1)}s editorial timeline`); continue; }
    const base = `chimera-${clip.id}`;
    const manifest = rec.entries.map(({ path, count }) => ({ path, count }));
    const seconds = rec.total / FPS;
    if (seconds < 15 || seconds > 40) throw new Error(`  note: ${seconds.toFixed(1)}s is outside the 15–40s pacing target`);
    const contentHash = sha256(rec.entries.map((e) => `${e.sha}:${e.count}`).join("\n"));

    const webm = join(outDir, `${base}.webm`);
    await encodeWebm({ ffmpeg, frames: manifest, fps: FPS, out: webm, signal: controller.signal });
    const webmProbe = await probeWithFfmpeg({ ffmpeg, video: webm });
    const webmDecoded = await decodedFrameHashes({ ffmpeg, video: webm, scratch, signal: controller.signal });
    if (webmDecoded.count !== rec.total) throw new Error(`${clip.id}: WebM decodes to ${webmDecoded.count} frames, expected ${rec.total}`);
    if (Math.abs(webmProbe.durationSeconds - seconds) > 0.1) throw new Error(`${clip.id}: WebM duration ${webmProbe.durationSeconds}s != ${seconds}s`);
    if (webmProbe.width !== FRAME.width || webmProbe.height !== FRAME.height) throw new Error(`${clip.id}: WebM is ${webmProbe.width}x${webmProbe.height}`);

    let mp4 = null;
    if (mp4Tool) {
      const mp4Path = join(outDir, `${base}.mp4`);
      try {
        await encodeMp4({ tool: mp4Tool, frames: manifest, fps: FPS, out: mp4Path, scratch, signal: controller.signal });
        const probed = await probeMp4({ tool: mp4Tool, video: mp4Path, signal: controller.signal });
        // "Supported" means a real decode returned every frame; the verify script adds real-browser playback.
        if (probed.codec !== "avc1" || probed.decodedFrames !== rec.total || probed.width !== FRAME.width || probed.height !== FRAME.height) {
          throw new Error(`decode check failed: ${JSON.stringify(probed)}`);
        }
        mp4 = { file: `${base}.mp4`, bytes: statSync(mp4Path).size, probe: probed };
      } catch (error) {
        rmSync(mp4Path, { force: true });
        console.warn(`  MP4 not published for ${clip.id}: ${error.message.split("\n")[0]}`);
      }
    }

    const poster = [...rec.posters].reverse().find((p) => p.late) ?? rec.posters[0] ?? rec.entries[Math.floor(rec.entries.length / 2)];
    copyFileSync(poster.path, join(outDir, `${base}.poster.jpg`));
    writeFileSync(join(outDir, `${base}.vtt`), `WEBVTT\n\n${rec.cues.map((cue, i) => `${i + 1}\n${clock(cue.start)} --> ${clock(cue.end)}\n${cue.text}\n`).join("\n")}`);
    writeFileSync(
      join(outDir, `${base}.steps.txt`),
      [
        `${clip.title}`,
        `${clip.subtitle}`,
        "",
        ...rec.steps.map((step) => `[${Math.floor(step.at / 60)}:${String(Math.floor(step.at % 60)).padStart(2, "0")}] ${step.text}`),
        "",
      ].join("\n"),
    );
    if (framesDir) {
      const target = join(framesDir, clip.id);
      mkdirSync(target, { recursive: true });
      rec.entries.forEach((e, i) => copyFileSync(e.path, join(target, `${String(i).padStart(4, "0")}-x${e.count}.jpg`)));
    }

    results.push({
      id: clip.id,
      headerFit,
      captureSourceRevision: git("rev-parse", "HEAD"),
      capturedAt: new Date().toISOString(),
      title: clip.title,
      scenario: clip.scenario,
      durationSeconds: Number(seconds.toFixed(3)),
      frames: rec.total,
      uniqueFrames: new Set(rec.entries.map((e) => e.sha)).size,
      uiFontPx: rec.uiFontPx,
      motion: rec.motion,
      files: {
        webm: { file: `${base}.webm`, bytes: statSync(webm).size },
        mp4: mp4 ? { file: mp4.file, bytes: mp4.bytes } : null,
        poster: `${base}.poster.jpg`,
        captions: `${base}.vtt`,
        steps: `${base}.steps.txt`,
      },
      steps: rec.steps.map((s) => ({ atSeconds: Number(s.at.toFixed(3)), text: s.text })),
      probes: {
        webm: webmProbe,
        mp4: mp4 ? { decoder: mp4.probe.decoder, codec: mp4.probe.codec, width: mp4.probe.width, height: mp4.probe.height, durationSeconds: mp4.probe.durationSeconds, decodedFrames: mp4.probe.decodedFrames } : null,
      },
      hashes: { contentHash, webmDecodedHash: webmDecoded.digest, webmSampledFrames: [0, Math.floor(rec.total / 2), rec.total - 1].map(index => ({ index, sha256: webmDecoded.frames[index] })), mp4DecodedHash: mp4?.probe.decodedHash ?? null },
    });
    console.log(`  ${seconds.toFixed(1)}s · ${rec.total} frames (${results.at(-1).uniqueFrames} unique) · webm ${(results.at(-1).files.webm.bytes / 1024).toFixed(0)} KiB${mp4 ? ` · mp4 ${(mp4.bytes / 1024).toFixed(0)} KiB` : " · mp4 skipped"}`);
  }

  // A visual-QA repair can replace selected films while retaining each film's honest capture SHA.
  if (wantedClips.length && flag('refresh-manifest') && !preflight) {
    const previous=JSON.parse(readFileSync(join(outDir,'provenance.json'),'utf8'));
    const byId=new Map(previous.clips.map(c=>[c.id,{...c,captureSourceRevision:c.captureSourceRevision??previous.sourceRevision,capturedAt:c.capturedAt??previous.capturedAt}]));
    for(const c of results) byId.set(c.id,c);
    results.splice(0,results.length,...CLIPS.map(c=>byId.get(c.id)).filter(Boolean));
  }
  if ((wantedClips.length === 0 || flag('refresh-manifest')) && !preflight) {
    const outputRelative = relative(repoRoot, outDir);
    const dirty = git("status", "--porcelain", "--", ".", ...(!outputRelative.startsWith("..") ? [`:!${outputRelative}`] : []), ':!site/assets/videos').length > 0;
    const scale = (px, width) => Number((px * width / FRAME.width).toFixed(1));
    const uiPx = results.find((r) => r.uiFontPx)?.uiFontPx ?? null;
    const provenance = {
      notice: "These videos film the real Chimera UI against a SCRIPTED FIXTURE daemon with fictional 'Atlas website' data. They are not a live workspace, not a recording of agents working, and not a performance measurement.",
      productBaseRevision: PRODUCT_BASE,
      productBaseTree: PRODUCT_TREE,
      capturedAt: new Date().toISOString(),
      sourceRevision: git("rev-parse", "HEAD"),
      sourceRevisionMeaning: "Collection assembly/capture pipeline revision; each clip carries its own exact captureSourceRevision.",
      captureSourceRevisions: [...new Set(results.map(c=>c.captureSourceRevision))],
      sourceTreeDirty: dirty,
      finalRecapture: "Captured from the committed product and fixture source snapshot recorded above; each clip retains its exact capture revision.",
      capturedWith: { browser: browserVersion, ffmpeg: ffmpegVersion, webmEncoder: "libvpx (VP8)", mp4Encoder: mp4Tool ? "AVFoundation H.264 via scripts/marketing-video-mp4.swift (macOS)" : null, ffprobe: "Final verification requires FFprobe; verification.json records its version and stream/container results. Capture probes use ffmpeg and AVAssetReader." },
      timeline: { fps: FPS, viewport: `${FRAME.width}x${FRAME.height}`, clockFrozenAt: FROZEN_AT, note: "Video time is frame index / fps. Pointer glides, typing cadence and holds are scripted, so durations say nothing about live latency." },
      presentation: { persistentDemoLabel: false, provenance: "provenance.json and provenance.md document fictional data, scripted RPC and synthetic desktop imagery; linked from the gallery" },
      fixtureVsReal: FIXTURE_VS_REAL,
      readability: {
        note: "Text size in CSS px when the 1280px-wide video fills the given player width. The UI body text is not legible at phone width; the captions are the readable layer, and the text steps carry the same content.",
        captionPx: { 1280: FRAME.captionFont, 768: scale(FRAME.captionFont, 768), 390: scale(FRAME.captionFont, 390) },
        uiBodyPx: uiPx === null ? null : { 1280: uiPx, 768: scale(uiPx, 768), 390: scale(uiPx, 390) },
      },
      reproduce: "node scripts/marketing-video.mjs --capture",
      determinism: "Compare two captures with: node scripts/marketing-video-verify.mjs --compare <dirA> <dirB> (decoded start/middle/end hashes; also reports full-sequence equality; container bytes are not promised identical).",
      clips: results,
    };
    writeFileSync(join(outDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
    const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;
    writeFileSync(
      join(outDir, "provenance.md"),
      [
        "# Usage video provenance",
        "",
        `> ${provenance.notice}`,
        "",
        `- Captured from source revision \`${provenance.sourceRevision}\`${dirty ? " (working tree had uncommitted changes)" : ""}. Product/capture source snapshot: ${PRODUCT_BASE}; tree ${PRODUCT_TREE}.`,
        `- Browser: ${browserVersion}. Encoders: libvpx VP8 → WebM${mp4Tool ? "; AVFoundation H.264 → MP4 (macOS only, best effort)" : "; no MP4 on this machine"}. Final verification requires FFprobe; capture probes come from \`ffmpeg -i\` and AVAssetReader.`,
        `- Timeline: ${FPS} fps fixed, ${FRAME.width}×${FRAME.height}, page clock frozen at ${FROZEN_AT}. Durations are not performance evidence.`,
        `- Reproduce: \`${provenance.reproduce}\``,
        "",
        "## Real vs scripted",
        "",
        ...FIXTURE_VS_REAL.real.map((line) => `- Real: ${line}`),
        ...FIXTURE_VS_REAL.scripted.map((line) => `- Scripted: ${line}`),
        "",
        "## Clips",
        "",
        "| Clip | Duration | Frames | WebM | MP4 | Shows | Capture source |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...results.map((r) => `| ${r.files.webm.file.replace(/\.webm$/, "")} | ${r.durationSeconds.toFixed(1)}s | ${r.frames} | ${kib(r.files.webm.bytes)} | ${r.files.mp4 ? kib(r.files.mp4.bytes) : "-"} | ${r.scenario} | ${r.captureSourceRevision} |`),
        "",
      ].join("\n"),
    );
  } else {
    console.log("\n(--clip given: provenance.{json,md} left untouched; they always describe the full set)");
  }
  console.log(`\nDone: ${results.length} clip(s) in ${relative(repoRoot, outDir) || "."}`);
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
} finally {
  await cdp?.close();
  await terminateOwnedProcess(chrome);
  await fixture?.close();
  await removeScratchDirectory(scratch);
}

// This standalone CLI imports Vite, whose worker handles can survive server.close()/esbuild.stop().
// All owned services and scratch files are closed above; flush the small report before ending the CLI.
await new Promise((done) => process.stdout.write('', done));
await new Promise((done) => process.stderr.write('', done));
process.exit(process.exitCode ?? 0);
