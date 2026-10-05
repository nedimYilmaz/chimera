# Usage video provenance

> These videos film the real Chimera UI against a SCRIPTED FIXTURE daemon with fictional 'Atlas website' data. They are not a live workspace, not a recording of agents working, and not a performance measurement.

- Captured from source revision `7b1ac1f6888e8f711442d9fe048f246b11be9897`. Product/capture source snapshot: 7b1ac1f6888e8f711442d9fe048f246b11be9897; tree b16b42bfc2695a4a219796554d48d9c561d6c63a.
- Browser: Chrome/154.0.8037.93. Encoders: libvpx VP8 → WebM; AVFoundation H.264 → MP4 (macOS only, best effort). Final verification requires FFprobe; capture probes come from `ffmpeg -i` and AVAssetReader.
- Timeline: 15 fps fixed, 1280×800, page clock frozen at 2026-01-12T09:30:00.000Z. Durations are not performance evidence.
- Reproduce: `node scripts/marketing-video.mjs --capture`

## Real vs scripted

- Real: The production React components: TopBar, Queues, Memory, agent inspector/ContextLinks/Resources, Projects/Canvas, ComputerUseMonitor and Footer on the production app store/reducer
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
| chimera-team-queue-lifecycle | 36.8s | 552 | 4092 KiB | 4975 KiB | team/queue lifecycle on the Atlas release queue | 7b1ac1f6888e8f711442d9fe048f246b11be9897 |
| chimera-memory-search-link | 26.7s | 401 | 3208 KiB | 3650 KiB | memory search, open a note, follow a [[link]] and see the backlink | 8c088dc0377ee8aeacbbd40f154ca38109f9c043 |
| chimera-context-handoff | 28.4s | 426 | 3445 KiB | 4206 KiB | explicit context snapshot and revocation; scripted RPC only | 8c088dc0377ee8aeacbbd40f154ca38109f9c043 |
| chimera-resource-diagnostics | 22.2s | 333 | 2148 KiB | 2441 KiB | read-only resource attribution and capped admission; fictional metrics | 8c088dc0377ee8aeacbbd40f154ca38109f9c043 |
| chimera-project-canvas | 25.0s | 375 | 1898 KiB | 2155 KiB | existing project entities in Canvas; synthetic relationship metadata | 8c088dc0377ee8aeacbbd40f154ca38109f9c043 |
| chimera-desktop-preview | 23.4s | 351 | 2184 KiB | 2666 KiB | real desktop monitor with synthetic target; no real desktop control | 8c088dc0377ee8aeacbbd40f154ca38109f9c043 |
