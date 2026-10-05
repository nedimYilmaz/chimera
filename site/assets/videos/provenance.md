# Usage video provenance

> These videos film the real Chimera UI against a SCRIPTED FIXTURE daemon with fictional 'Atlas website' data. They are not a live workspace, not a recording of agents working, and not a performance measurement.

- Captured from source revision `f9c0bc83cf6c094c30b39aaf329f773992dbe7a9`. Product base: 3a6898e7783bc92d5cbc71e929fb2204a2fcd96a; accepted tree de4190fe28a50d4dc9ab60430d20b20a5a91e98f.
- Browser: Chrome/154.0.8037.93. Encoders: libvpx VP8 → WebM; AVFoundation H.264 → MP4 (macOS only, best effort). Final verification requires FFprobe; capture probes come from `ffmpeg -i` and AVAssetReader.
- Timeline: 15 fps fixed, 1280×800, page clock frozen at 2026-01-12T09:30:00.000Z. Durations are not performance evidence.
- On every frame: "Demo data · scripted daemon · fictional Atlas".
- Reproduce: `node scripts/marketing-video.mjs --capture`

## Real vs scripted

- Real: The production React components: TopBar, Queues, Memory, agent inspector/ContextLinks/Resources, Projects/Canvas, ComputerUseMonitor and Footer on the production app store/reducer
- Real: Every click, keystroke and focus change is a real input event dispatched into that UI through the browser's DevTools protocol
- Real: Queue and memory screens refetch through their own coordination-event refresh path
- Scripted: The daemon: a scripted fixture answers every RPC; nothing is spawned, scheduled or executed
- Scripted: Task state changes (pending, in progress, done) are replayed by the script; no worker ran the task
- Scripted: All data is fictional: the Atlas website demo project, /demo paths and invented note text
- Scripted: Visual treatment: disclosure/captions/cursor overlay, production animations settled; deterministic eased camera, kinetic titles/captions and pointer/click overlays; measured fixture RTT hidden
- Scripted: Timing: the film is sampled at a fixed 15 frames per second, so durations here are not response times

## Clips

| Clip | Duration | Frames | WebM | MP4 | Shows | Capture source |
| --- | --- | --- | --- | --- | --- | --- |
| chimera-team-queue-lifecycle | 36.7s | 551 | 4105 KiB | 5170 KiB | team/queue lifecycle on the Atlas release queue | 80e27ddb0f45c17c59cf209d06a28530260f66ef |
| chimera-memory-search-link | 27.1s | 407 | 3474 KiB | 3927 KiB | memory search, open a note, follow a [[link]] and see the backlink | f9c0bc83cf6c094c30b39aaf329f773992dbe7a9 |
| chimera-context-handoff | 28.3s | 425 | 3375 KiB | 4231 KiB | explicit context snapshot and revocation; scripted RPC only | 1073f95dcebfabecf9f2006aa3646860858caa57 |
| chimera-resource-diagnostics | 22.5s | 338 | 2402 KiB | 2730 KiB | read-only resource attribution and capped admission; fictional metrics | f9c0bc83cf6c094c30b39aaf329f773992dbe7a9 |
| chimera-project-canvas | 25.0s | 375 | 2055 KiB | 2291 KiB | existing project entities in Canvas; synthetic relationship metadata | 80e27ddb0f45c17c59cf209d06a28530260f66ef |
| chimera-desktop-preview | 23.8s | 357 | 2382 KiB | 2945 KiB | real desktop monitor with visibly labelled synthetic target; no real desktop control | 1073f95dcebfabecf9f2006aa3646860858caa57 |
