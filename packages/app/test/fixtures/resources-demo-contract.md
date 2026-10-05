# Resource attribution demo contract (UX26-R)

Use the existing `ui-browser.tsx` fixture with `window.__UI_QA__.show("resources")`.
It mounts the real Agents screen with 301 synthetic workers and the selected worker's
AgentDetailPanel. Existing synthetic records can remain in the store. The Resources
disclosure starts collapsed and performs no fleet scan. Open its native summary;
`window.__UI_QA__.resources.pending()` then reports one deferred request.

`resources.settle(mode)` resolves the next request: `ok` (300 processes, 300 MiB RSS,
30% CPU, admission 6/6 with ceiling 8), `stale` (15-second-old retained sample,
partial-tree flag), `unavailable` (Windows/platform with null metrics), `fail-open`
(host monitoring unavailable), `error` (retryable scan error), or `unsupported`
(older daemon capability). `resources.cycle()` requests a refresh through a real
store disconnect/reconnect edge; `resources.connected(false/true)` allows late-reply
and reconnect demonstrations. CPU and RSS are synthetic OS metrics, separate from
token context. Shared daemon MCP services are excluded. No kill/stop controls exist
inside the resource disclosure.

The process list renders at most fourteen rows at once. On narrow screens, use the
existing stacked-pane scroller to reach the inspector/composer. Required browser
probes cover states, retained stale data, closed disclosure without fleet scans,
and 360/768/1440-pixel geometry with an unobstructed composer after scrolling.

Do not present the fixture as live machine measurement. Real verification is a
separate macOS test with a temporary Node parent and three sleep children. Linux ps
syntax is fixture-tested; Windows is unavailable, and Codex SDK exec hides its PID.
Claude, Codex app-server and a single exact tmux pane have owned-root attribution.
RSS includes shared pages; it is not unique physical RAM. CPU requires two samples,
and Linux counters may have one-second granularity. No live app/daemon restart,
provider call, account change or external upload is needed for capture.
