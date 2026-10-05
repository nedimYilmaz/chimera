# Usage video provenance

> The first film is original illustrated animation explaining Chimera capability families. The eleven interface demos film the real Chimera UI against a SCRIPTED FIXTURE daemon with fictional 'Atlas website' data. None records agents executing work or measures performance.

- Captured from source revision `4b26d30a9acef38e104105b512a4e86bf46acec7`. Product/capture source snapshot: 4b26d30a9acef38e104105b512a4e86bf46acec7; tree c61cf10706fbaa6e7e4fe80ed9d8f365f554b199.
- Browser: Chrome/154.0.8037.93. Encoders: libvpx VP8 → WebM; AVFoundation H.264 → MP4 (macOS only, best effort). Final verification requires FFprobe; capture probes come from `ffmpeg -i` and AVAssetReader.
- Timeline: 15 fps fixed, 1280×800, page clock frozen at 2026-01-12T09:30:00.000Z. Durations are not performance evidence.
- Reproduce: `node scripts/marketing-video.mjs --capture`

## Interface demos: real vs scripted

- Real: The production React components: TopBar, Teams, Roles, Queues/Schedules, Settings/MCP/Secrets, Memory, agent inspector/ContextLinks/Resources, Projects/Canvas, ComputerUseMonitor and Footer on the production app store/reducer
- Real: Every click, keystroke and focus change is a real input event dispatched into that UI through the browser's DevTools protocol
- Real: Queue and memory screens refetch through their own coordination-event refresh path
- Scripted: The daemon: a scripted fixture answers every RPC; nothing is spawned, scheduled or executed
- Scripted: Task state changes (pending, in progress, done) are replayed by the script; no worker ran the task
- Scripted: All data is fictional: the Atlas website demo project, /demo paths and invented note text
- Scripted: Visual treatment: captions/cursor overlay, production animations settled; deterministic eased camera, kinetic titles/captions and pointer/click overlays; measured fixture RTT hidden
- Scripted: Desktop target: a synthetic SVG drawn by marketing-features.ts inside the real monitor; its lease and action history are scripted, no desktop was captured or controlled
- Scripted: Timing: the film is sampled at a fixed 15 frames per second, so durations here are not response times

## Clips

| Clip | Duration | Frames | WebM | MP4 | Shows | Capture source |
| --- | --- | --- | --- | --- | --- | --- |
| chimera-team-worker-overview | 22.9s | 343 | 2396 KiB | 2788 KiB | inspect the Atlas team and one worker | 4b26d30a9acef38e104105b512a4e86bf46acec7 |
| chimera-role-library-binding | 22.3s | 334 | 2215 KiB | 2638 KiB | compare a library role with its Atlas team binding | 4b26d30a9acef38e104105b512a4e86bf46acec7 |
| chimera-schedule-run-history | 22.4s | 336 | 2505 KiB | 2985 KiB | inspect the Atlas accessibility schedule and filter run history | 4b26d30a9acef38e104105b512a4e86bf46acec7 |
| chimera-mcp-tool-inspection | 23.7s | 355 | 2640 KiB | 3058 KiB | open the fictional Atlas docs server tool list | 4b26d30a9acef38e104105b512a4e86bf46acec7 |
| chimera-secret-access-inspection | 24.8s | 372 | 2527 KiB | 2857 KiB | search fictional secret metadata and inspect access controls without revealing values | 4b26d30a9acef38e104105b512a4e86bf46acec7 |
| chimera-team-queue-lifecycle | 36.8s | 552 | 4092 KiB | 4975 KiB | team/queue lifecycle on the Atlas release queue | 7b1ac1f6888e8f711442d9fe048f246b11be9897 |
| chimera-memory-search-link | 26.7s | 401 | 3208 KiB | 3650 KiB | memory search, open a note, follow a [[link]] and see the backlink | 8c088dc0377ee8aeacbbd40f154ca38109f9c043 |
| chimera-context-handoff | 28.4s | 426 | 3445 KiB | 4206 KiB | explicit context snapshot and revocation; scripted RPC only | 8c088dc0377ee8aeacbbd40f154ca38109f9c043 |
| chimera-resource-diagnostics | 22.2s | 333 | 2148 KiB | 2441 KiB | read-only resource attribution and capped admission; fictional metrics | 8c088dc0377ee8aeacbbd40f154ca38109f9c043 |
| chimera-project-canvas | 25.0s | 375 | 1898 KiB | 2155 KiB | existing project entities in Canvas; synthetic relationship metadata | 8c088dc0377ee8aeacbbd40f154ca38109f9c043 |
| chimera-desktop-preview | 23.4s | 351 | 2184 KiB | 2666 KiB | real desktop monitor with synthetic target; no real desktop control | 8c088dc0377ee8aeacbbd40f154ca38109f9c043 |

## Illustrated product overview

Original Canvas animation, not real product UI. Conceptual illustration, not a recording of agents working. Worktrees isolate git changes, not processes. Snapshot branches are explicit saved context, not native provider session forks. Desktop control is macOS only; platform and provider capabilities vary. See the feature guide for availability. No usage or performance figures are shown.

- Exact scene/capture source: `1e873f8a908c96d5a9e40d73bc10733b70688aa1`, tree `24c3f88b3dfb454aa4aa68de06ed6d22e7e908a8`; clean committed source.
- 90 seconds, 2700 frames, 30fps, 1600×1000, silent H.264 MP4 (5107010 bytes) and VP8 WebM (10129444 bytes).
- Browser: Chrome/154.0.8037.93. Encoders: libx264 and libvpx; ffmpeg version 9.0.2-https://www.martin-riedl.de Copyright (c) 2000-2026 the FFmpeg developers.
- Source: scripts/overview/story.json, scene.mjs and capture.mjs. Reproduce with `node scripts/overview/capture.mjs --out=/tmp/chimera-overview-final`.
- The eleven original films, their per-clip records and their assets were preserved. Their 15fps collection timeline above does not apply to this overview.
- Container SHA256 and complete decoded-frame hashes are recorded in the new clip entry. No second-capture pixel identity or live-provider claim.
