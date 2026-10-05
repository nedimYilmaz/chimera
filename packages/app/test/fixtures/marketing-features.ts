// Fictional "Atlas" data for the feature-focus marketing screens (MCP store, secrets, schedules,
// ...). It is a second RPC layer composed AHEAD of `marketingRpc` (see marketing-boot.ts): a method
// handled here wins, anything else falls through to the base fixture. Same rules as the base data:
// nothing here is real — hosts use the reserved `.invalid` TLD, secrets are names only (a value
// never exists in this file or on the wire), and every id belongs to the seeded Atlas agents.
// Shapes mirror the protocol schemas the real components parse, so a drift fails loudly in the
// UI (error toast) instead of rendering a plausible-looking lie.
import { DEMO_CWD, NOW, agentRecords, ago, ids, teams as baseTeams } from "./marketing-data";

export const MISS = Symbol("marketing-feature-rpc-miss");

// Which screenshot view is mounted (set by marketing.tsx before it mounts). The richer team / role /
// project / checkpoint answers below belong to ONE view each: the accepted baseline shots (workspace,
// queue, ...) keep the plain base fixture, so e.g. no checkpoint strip appears under the workspace.
export const featureState = { view: "" };
const on = (...views: string[]) => views.includes(featureState.view);

const HOME = "/demo/chimera"; // fictional runtime root; real entries are absolute paths under the app's data dir

// ── MCP store ───────────────────────────────────────────────────────────────────────────────
// 86 base64 chars + "==" is what McpManagedPackageSchema's sha512 integrity check requires.
const FICTIONAL_INTEGRITY = `sha512-${"AtlasDemoIntegrity0123456789".padEnd(86, "x")}==`;

const stdio = (o: Record<string, unknown>) => ({ type: "stdio", args: [], env: {}, direct: false, enabled: true, trust: "full", ...o });
const http = (o: Record<string, unknown>) => ({ type: "http", headers: {}, direct: false, enabled: true, trust: "full", ...o });

const mcpEntries = [
  // The three built-ins mirror laya/browser/desktopEntry() in packages/core/src/computer-use.ts:
  // same args, same session modes (shared / per-agent / exclusive), stamped with `builtIn`.
  stdio({
    name: "laya", command: `${HOME}/runtime/laya/bin/python`, args: ["-m", "laya.mcp.server"],
    env: { LAYA_PRELOAD: "0", LAYA_THREADS: "4" }, sessionMode: "shared", builtIn: { id: "laya", version: "0.3.27" },
  }),
  stdio({
    name: "chimera-browser", command: `${HOME}/runtime/node/bin/node`,
    args: [`${HOME}/runtime/playwright-mcp/cli.js`, "--isolated", "--headless", "--caps", "vision"],
    sessionMode: "agent", builtIn: { id: "chimera-browser", version: "0.0.83" },
  }),
  stdio({
    name: "chimera-desktop", command: `${HOME}/runtime/cua-driver/cua-driver`,
    args: ["mcp", "--embedded", "--socket", `${HOME}/computer-use/desktop.sock`],
    env: { CUA_DRIVER_EMBEDDED: "1" }, sessionMode: "exclusive", builtIn: { id: "chimera-desktop", version: "0.33.3" },
  }),
  // External servers: one per auth state the settings screen can show.
  http({ name: "atlas-docs", url: "https://docs.atlas.invalid/mcp", auth: { kind: "oauth", keychainRef: "mcp-oauth-atlas-docs", scopes: ["docs.read"] } }),
  http({ name: "atlas-tracker", url: "https://tracker.atlas.invalid/mcp", auth: { kind: "bearer", keychainRef: "mcp-bearer-atlas-tracker" } }),
  http({ name: "atlas-support", url: "https://support.atlas.invalid/mcp", auth: { kind: "oauth", keychainRef: "mcp-oauth-atlas-support", scopes: ["tickets.read"] } }),
  http({ name: "atlas-calendar", url: "https://calendar.atlas.invalid/mcp", auth: { kind: "oauth", keychainRef: "mcp-oauth-atlas-calendar" } }),
  // One chip per row: the row renders its badges inline with no gap, so stacked chips run together.
  http({ name: "atlas-metrics", url: "https://metrics.atlas.invalid/mcp", trust: "untrusted" }),
  stdio({
    name: "atlas-notes", command: `${HOME}/mcp-packages/atlas-notes-mcp/bin/atlas-notes-mcp`, args: ["--readonly"], sessionMode: "agent",
    managed: { id: "5b0e8f6a-7c3d-4e21-9a4f-2d8c61b7e093", ecosystem: "npm", packageName: "atlas-notes-mcp", version: "1.4.2", integrity: FICTIONAL_INTEGRITY, bin: "atlas-notes-mcp" },
  }),
];

const authStatus = [
  { name: "atlas-docs", state: "authorized", detail: "authorized — last connection succeeded", authorizedAt: ago(60 * 26), lastCheckedAt: ago(4), scopes: ["docs.read"] },
  { name: "atlas-tracker", state: "bearer", detail: "static token (no expiry chimera can observe)" },
  { name: "atlas-support", state: "needs-reauth", detail: "the last connection was rejected — the grant was revoked or expired", authorizedAt: ago(60 * 24 * 12), lastCheckedAt: ago(35), scopes: ["tickets.read"] },
  { name: "atlas-calendar", state: "never", detail: "never authorized — run the Authorize flow once" },
  { name: "atlas-metrics", state: "none", detail: "no authorization configured" },
];

const importables = [
  { source: "claude", name: "atlas-docs", type: "http", url: "https://docs.atlas.invalid/mcp", requiresAuth: true },
  { source: "claude", name: "atlas-lint", type: "stdio", command: "/demo/tools/atlas-lint/bin/atlas-lint-mcp", args: ["--stdio"] },
  { source: "codex", name: "atlas-search", type: "http", url: "https://search.atlas.invalid/mcp", requiresAuth: false },
];

const docsTools = [
  ["search_docs", "Full-text search across the Atlas docs site, returning page titles and anchors."],
  ["get_page", "Fetch one docs page as Markdown by its path."],
  ["list_changelog", "List recent release-notes entries with their dates and version tags."],
  ["get_style_guide", "Return the Atlas writing style guide section for a given topic."],
] as const;

// ── Secrets ─────────────────────────────────────────────────────────────────────────────────
// `secret.list` carries names, descriptions and grants only — values are write-only by design.
// The two-grant secret is listed first: the capture opens the FIRST card, so its grant controls stay above the fold.
const secrets = [
  { name: "ATLAS_DESIGN_EXPORT_TOKEN", description: "Exports approved pricing-page assets from the design library", updatedAt: ago(60 * 5),
    grants: [
      { agentId: ids.pricing, mode: "inject", agentLabel: "Pricing page builder" },
      { agentId: ids.a11y, mode: "reveal", agentLabel: "Accessibility auditor" },
    ] },
  { name: "ATLAS_STAGING_DEPLOY_TOKEN", description: "Deploys the Atlas website preview to staging", updatedAt: ago(60 * 24 * 3),
    grants: [{ agentId: ids.pricing, mode: "inject", agentLabel: "Pricing page builder" }] },
  { name: "ATLAS_ANALYTICS_READ_KEY", description: "Read-only key for the pricing-page analytics export", updatedAt: ago(60 * 24 * 9),
    grants: [{ agentId: ids.conductor, mode: "reveal", agentLabel: "Atlas conductor" }] },
  { name: "ATLAS_CMS_WEBHOOK_SECRET", description: "Signs the CMS publish webhook used by the docs pipeline", updatedAt: ago(60 * 24 * 21), grants: [] },
  { name: "ATLAS_PREVIEW_INBOX_LOGIN", description: "Test-inbox login for the release-notes email preview", updatedAt: ago(60 * 24 * 40), grants: [] },
];

// ── Schedules ───────────────────────────────────────────────────────────────────────────────
const MIN = 60_000;
type RunOpts = { agentId?: string | null; taskId?: string | null; cost?: number; error?: string; reason?: string; lateMs?: number; coalesced?: number };
const run = (minutesAgo: number, trigger: string, result: string, o: RunOpts = {}) => ({
  ts: ago(minutesAgo), trigger, result, agentId: o.agentId ?? null, taskId: o.taskId ?? null, costUsd: o.cost ?? 0,
  error: o.error ?? null, exitCode: null, output: null, latenessMs: o.lateMs ?? null, coalescedOccurrences: o.coalesced ?? null,
  reason: o.reason ?? null, nominalFireTs: null, attempt: 0,
});
const DAY = 60 * 24;
const team = (role?: string) => ({ team: "atlas", ...(role ? { role } : {}) });

const jobs = [
  {
    name: "atlas-nightly-regression", enabled: true, target: team("auditor"), schedule: { cron: "0 2 * * 1-5" }, tz: "UTC",
    prompt: "Run the visual regression suite against the staged Atlas pricing page and file one task per diff.",
    nextRunTs: NOW + 200 * MIN, catchUpMaxStalenessMs: 6 * 60 * MIN, consecutiveFailures: 0, failure: null,
    lastRuns: [5, 4, 3, 2, 1].map((d) => run(d * DAY - 40, "scheduled", "ok", { taskId: `4c1${d}a9e${d}`, cost: 0.41 + d / 50 })),
  },
  {
    name: "atlas-docs-link-check", enabled: true, target: team("reviewer"), schedule: { every: { n: 6, unit: "hours" } },
    prompt: "Crawl the docs site, report broken links and anchors, and open a task for each owner.",
    nextRunTs: NOW + 146 * MIN, catchUpMaxStalenessMs: 3 * 60 * MIN, consecutiveFailures: 0, failure: null,
    lastRuns: [4, 3, 2, 1].map((n) => run(n * 360 - 34, "scheduled", "ok", { taskId: `d9e0b2${n}f`, cost: 0.18 })),
  },
  {
    name: "atlas-weekly-pricing-digest", enabled: true,
    target: { role: "writer", overrides: { cwd: DEMO_CWD, model: "claude-sonnet-5-5" } }, schedule: { cron: "0 9 * * 1" }, tz: "Europe/Berlin",
    prompt: "Summarize last week's pricing-page changes and the open review comments as a short digest.",
    nextRunTs: NOW + 3 * DAY * MIN, catchUpMaxStalenessMs: 12 * 60 * MIN, consecutiveFailures: 0, failure: null,
    lastRuns: [21, 14, 7].map((d) => run(d * DAY - 90, "scheduled", "ok", { agentId: ids.notes, cost: 0.27 })),
  },
  {
    // The selected job: a retry in flight, with the run history showing every trigger kind the
    // scheduler records (scheduled, manual, catch-up, sleep-wake) and a skipped slot.
    name: "atlas-a11y-sweep", enabled: true, target: team("auditor"), schedule: { cron: "30 6 * * *" }, tz: "UTC",
    prompt: "Sweep the staged Atlas pricing page for WCAG 2.2 AA violations; file one task per violation and post a summary to the conductor.",
    nextRunTs: NOW + 15 * 60 * MIN, catchUpMaxStalenessMs: 6 * 60 * MIN, consecutiveFailures: 1,
    retryPolicy: { maxAttempts: 3 },
    failure: { deadLetterAt: null, retryAt: NOW + 3 * MIN, reasons: [{ ts: ago(27), error: "staging preview timed out (HTTP 504)" }] },
    wakeScheduling: { available: true, reason: null, setupHint: null, scheduledFor: NOW + 15 * 60 * MIN - 2 * MIN, holdingAwake: false },
    lastRuns: [
      run(10 * DAY, "manual", "ok", { agentId: ids.a11y, cost: 0.55 }),
      run(8 * DAY + 20, "catchup", "ok", { taskId: "a3f90c15", cost: 0.47 }),
      run(5 * DAY, "sleep-wake", "ok", { taskId: "a3f90c18", cost: 0.51, lateMs: 9 * 60 * MIN + 13 * MIN, coalesced: 3 }),
      run(4 * DAY, "scheduled", "skipped", { reason: "stale-beyond-window" }),
      run(1 * DAY, "scheduled", "ok", { taskId: "a3f90c1d", cost: 0.5 }),
      run(27, "scheduled", "failed", { taskId: "a3f90c1e", cost: 0.06, error: "staging preview timed out (HTTP 504)" }),
    ],
  },
  {
    // Dead-lettered: three failed attempts and the daemon stopped the schedule.
    name: "atlas-asset-cache-warm", enabled: false, target: { agentSpec: { cwd: DEMO_CWD, prompt: "Warm the CDN cache for the pricing page assets." } },
    schedule: { every: { n: 30, unit: "minutes" } }, nextRunTs: null, consecutiveFailures: 3, retryPolicy: { maxAttempts: 3 },
    failure: {
      deadLetterAt: ago(95), retryAt: null,
      reasons: [
        { ts: ago(215), error: "asset host unreachable (connection refused)" },
        { ts: ago(155), error: "asset host unreachable (connection refused)" },
        { ts: ago(95), error: "asset host unreachable (connection refused)" },
      ],
    },
    lastRuns: [
      run(300, "scheduled", "ok", { agentId: ids.pricing, cost: 0.04 }),
      run(270, "scheduled", "ok", { agentId: ids.pricing, cost: 0.04 }),
      run(215, "scheduled", "failed", { agentId: ids.pricing, cost: 0.01, error: "asset host unreachable (connection refused)" }),
      run(155, "scheduled", "failed", { agentId: ids.pricing, cost: 0.01, error: "asset host unreachable (connection refused)" }),
      run(95, "scheduled", "failed", { agentId: ids.pricing, cost: 0.01, error: "asset host unreachable (connection refused)" }),
    ],
  },
  {
    name: "atlas-staging-reset", enabled: false, disabledReason: "paused by the operator during the release freeze", target: team(),
    schedule: { cron: "0 22 * * 5" }, tz: "UTC", nextRunTs: null, consecutiveFailures: 0, failure: null,
    prompt: "Reset the staging dataset to the nightly snapshot.",
    lastRuns: [run(2 * DAY + 11 * 60, "scheduled", "ok", { taskId: "e57b30aa", cost: 0.09 })],
  },
];

const jobWithWake = (j: (typeof jobs)[number]) => ({
  retryPolicy: { maxAttempts: 3 },
  wakeScheduling: { available: true, reason: null, setupHint: null, scheduledFor: typeof j.nextRunTs === "number" ? j.nextRunTs - 2 * MIN : null, holdingAwake: false },
  ...j,
});

// ── Teams & roles ───────────────────────────────────────────────────────────────────────────
// Library roles carry NO cwd so a team binding's `cwd` override is visibly "pinned" against the
// inherited rest. Instructions are fictional one-liners (they render in the role blocks).
const libraryRoles = [
  { name: "conductor", model: "claude-opus-5-5", permissionProfile: "acceptEdits", effort: "high", instructions: "Plan the release, hand work to the team through the queue and keep the three gates tagged." },
  { name: "builder", model: "gpt-6-sol", permissionProfile: "acceptEdits", isolation: "worktree", maxTurns: 40, turnLimitPolicy: "soft", instructions: "Implement one queue task at a time in your own worktree; keep the diff small and run the page's tests before you report." },
  { name: "auditor", model: "gpt-6-astra", permissionProfile: "readOnly", maxTurns: 30, turnLimitPolicy: "fail", instructions: "Audit the built page against WCAG 2.2 AA. Read-only: report findings with the failing selector, never edit." },
  { name: "reviewer", model: "claude-sonnet-5-5", permissionProfile: "readOnly", instructions: "Review copy and markup against the brand guide; answer with a short approve / change-request list." },
  { name: "writer", model: "claude-sonnet-5-5", permissionProfile: "acceptEdits", instructions: "Draft release notes and in-page copy in the brand voice; cite the task each line comes from." },
];

const binding = (role: string, overrides: Record<string, unknown> = {}) => ({ role, overrides: { cwd: DEMO_CWD, ...overrides } });
const atlasTeam = {
  ...baseTeams[0]!,
  maxConcurrent: 4,
  createdBy: ids.conductor,
  projectNative: "atlas-website",
  // reviewer + writer were materialized from the project's .claude/agents; builder + auditor were added in Chimera.
  discoveredRoles: ["reviewer", "writer"],
  roles: { builder: binding("builder", { maxTurns: 60 }), auditor: binding("auditor", { maxTurns: 24 }), reviewer: binding("reviewer"), writer: binding("writer") },
};
const docsTeam = {
  name: "atlas-docs", purpose: "Keep the Atlas docs and release notes in step (demo project)", maxConcurrent: 2, queue: "atlas-docs", createdBy: null,
  roles: { writer: binding("writer"), reviewer: binding("reviewer") },
};
// The Teams list renders newest-first (it reverses the array), so the team shown on top goes LAST.
const teamList = [{ ...docsTeam, running: 0, totalRuns: 2 }, { ...atlasTeam, running: 3, totalRuns: 5 }];

// Live rows in the shape the daemon returns (record-like). The conductor and the finished agents are
// merged in from the store by mergeTeamAgents, exactly as in the real app.
const teamLiveAgents = ["pricing", "a11y"].map((key) => {
  const rec = agentRecords.find((r) => r.agentId === ids[key as "pricing" | "a11y"])!;
  return { agentId: rec.agentId, state: rec.state, accountName: rec.accountName, costUsd: rec.costUsd, membership: { team: "atlas", role: rec.spec.role }, spec: { prompt: rec.spec.prompt } };
});

// ── Projects ────────────────────────────────────────────────────────────────────────────────
const projectSpec = {
  name: "atlas-website", path: DEMO_CWD, origin: null, teams: ["atlas"], queue: "atlas-release", createdAt: ago(240), archived: false,
  autoConductor: true, conductorId: ids.conductor, permissionProfile: "acceptEdits", conductorAccount: "claude-demo", conductorModel: "claude-opus-5-5",
  loadProjectSettings: true, worktreeSetup: { command: "node scripts/setup-worktree-modules.mjs", timeoutSec: 120, enabled: true },
};
// Short branch names: the sessions table's branch column is narrow and wraps a "chimera/…" prefix into the next cell.
const branches: Record<string, string> = { [ids.pricing]: "pricing-ui", [ids.a11y]: "a11y-audit", [ids.docs]: "docs-review", [ids.notes]: "release-2-4" };
// Session records as project.status returns them: the conductor has NO team membership (that is what
// makes it a ◆ conductor row), every team session carries team + role and its own branch.
const projectSessions = agentRecords.map((r) => r.agentId === ids.conductor
  ? { ...r, membership: undefined, spec: { ...r.spec, conductor: true }, gitBranch: "main" }
  : { ...r, membership: { team: "atlas", role: r.spec.role }, gitBranch: branches[r.agentId] });

const checkpointList = [
  { id: "3", ref: "refs/chimera/checkpoints/3", trigger: "destructive_bash", ts: ago(9), message: 'chimera checkpoint before Bash: "rm -rf .next && pnpm build"' },
  { id: "2", ref: "refs/chimera/checkpoints/2", trigger: "task_start", ts: ago(31), message: "chimera checkpoint at task start 3c90e6a7" },
  { id: "1", ref: "refs/chimera/checkpoints/1", trigger: "manual", ts: ago(77), message: "chimera checkpoint (manual)" },
];
const fsEntry = (name: string, kind: "file" | "dir", gitStatus: string | null = null, sizeBytes: number | null = null) => ({ name, kind, sizeBytes: kind === "dir" ? null : sizeBytes, gitStatus });
const projectRootFiles = [
  fsEntry("docs", "dir"), fsEntry("public", "dir"), fsEntry("scripts", "dir"), fsEntry("src", "dir", "modified"),
  fsEntry(".gitignore", "file", null, 74), fsEntry("README.md", "file", null, 1_820), fsEntry("package.json", "file", "modified", 912), fsEntry("tsconfig.json", "file", null, 436),
];

// ── Computer use (demo) ─────────────────────────────────────────────────────────────────────
// The lease is held by the seeded builder, and only while the computer-use view is mounted.
const DEMO_WINDOW_ID = 4242;
const leaseMonitor = {
  held: true, owner: ids.pricing, ownerName: "Pricing page builder", busy: true, windowId: DEMO_WINDOW_ID,
  activities: [
    { id: 11, ts: NOW - 52_000, agentId: ids.pricing, tool: "screenshot", state: "succeeded" },
    { id: 12, ts: NOW - 38_000, agentId: ids.pricing, tool: "click", state: "succeeded" },
    { id: 13, ts: NOW - 21_000, agentId: ids.pricing, tool: "type_text", state: "succeeded" },
    { id: 14, ts: NOW - 6_000, agentId: ids.pricing, tool: "click", state: "running" },
  ],
};

// A synthetic stand-in for the desktop target — drawn here, never captured from a screen.
// Asset provenance documents its origin; the presentation omits repeated demo labels.
const demoTarget = () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600" font-family="system-ui, sans-serif">
<rect width="960" height="600" fill="#101419"/>
<rect x="40" y="52" width="880" height="508" rx="10" fill="#1a2028" stroke="#2c3541"/>
<rect x="40" y="52" width="880" height="34" rx="10" fill="#232b35"/>
<circle cx="64" cy="69" r="6" fill="#e5675d"/><circle cx="86" cy="69" r="6" fill="#e6b455"/><circle cx="108" cy="69" r="6" fill="#62c370"/>
<text x="480" y="74" fill="#8b97a6" font-size="14" text-anchor="middle">Atlas pricing — preview</text>
<text x="80" y="140" fill="#e8edf3" font-size="26" font-weight="600">Pick the plan that fits</text>
<g font-size="15" fill="#c9d2dd">
<rect x="80" y="170" width="250" height="230" rx="10" fill="#202833" stroke="#2c3541"/><text x="100" y="204" font-weight="600">Starter</text><text x="100" y="244" font-size="30" fill="#e8edf3">$0</text><text x="100" y="284">3 projects</text><text x="100" y="312">Community support</text>
<rect x="355" y="170" width="250" height="230" rx="10" fill="#202833" stroke="#4d8fe8" stroke-width="2"/><text x="375" y="204" font-weight="600">Team</text><text x="375" y="244" font-size="30" fill="#e8edf3">$24</text><text x="375" y="284">Unlimited projects</text><text x="375" y="312">Shared queues</text>
<rect x="630" y="170" width="250" height="230" rx="10" fill="#202833" stroke="#2c3541"/><text x="650" y="204" font-weight="600">Scale</text><text x="650" y="244" font-size="30" fill="#e8edf3">$96</text><text x="650" y="284">Audit trail</text><text x="650" y="312">Priority support</text>
</g>
<rect x="375" y="350" width="120" height="34" rx="6" fill="#4d8fe8"/><text x="435" y="372" fill="#fff" font-size="14" text-anchor="middle">Choose Team</text>
<circle cx="435" cy="367" r="16" fill="none" stroke="#f0b429" stroke-width="3"/>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

// ── Machine / provider plumbing the settings screen loads on mount ──────────────────────────
const config = {
  autoOrder: ["claude-demo", "codex-demo"], preferredProvider: "claude", dailyCapUsd: null, projectImportDir: null,
  caps: { maxAgentsTotal: 8, perAccount: {}, dynamicCap: false },
};

export function featureRpc(method: string, params: Record<string, unknown> = {}): unknown {
  switch (method) {
    case "mcpstore.list": return mcpEntries;
    case "mcpstore.importables": return { importables };
    case "mcpstore.authStatus": return { servers: authStatus };
    case "mcpstore.detectAuth":
      return { oauth: false };
    case "mcpstore.tools": {
      const name = String(params["query"] ?? "");
      return name === "atlas-docs"
        ? { servers: [{ server: name, connected: true, tools: docsTools.map(([n, description]) => ({ server: name, name: n, description, inputSchema: { type: "object" }, readOnlyHint: true })) }] }
        : { servers: [{ server: name, connected: true, tools: [] }] };
    }
    case "mcpstore.monitor": return on("computer-use") ? leaseMonitor : { held: false, owner: null, ownerName: null, busy: false, windowId: null, activities: [] };
    case "computerUse.builtins.status":
      return {
        managed: true,
        integrations: [
          { id: "laya", state: "ready", provisioning: "managed-download", version: "0.3.27", modelAssets: "downloaded-on-first-use" },
          { id: "chimera-browser", state: "ready", provisioning: "bundled", version: "0.0.83" },
          { id: "chimera-desktop", state: "ready", provisioning: "bundled", version: "0.33.3" },
        ],
      };
    case "config.get": return config;
    case "accounts.list": return [{ name: "claude-demo", provider: "claude" }, { name: "codex-demo", provider: "codex" }];
    case "providers.list": return [];
    case "fed.network": return { installed: false, loggedIn: false, ip4: null, magicDNS: null, tailscaleSSH: false };
    case "fed.cloudflare": return { installed: false, provisioned: false, hostname: null, tunnelHealth: "unknown", selfprobe: "pending", accessTokenExpiry: null };
    case "secret.list": return { secrets };
    // The Queues tab loads these for its palette/search sources; the demo has none registered.
    case "workflow.list":
    case "artifact.list": return [];
    // The baseline views call these too; an explicit "nothing here" keeps the miss-detector honest.
    // fs.resolve → null is the real "not a file" answer (text stays plain), unlike the old [].
    case "group.list": return { groups: [] };
    // AgentInspector (a selected Teams row) asks who subscribes to the agent; the demo has no subscriptions.
    case "sub.list": return [];
    case "checkpoint.status":
      return on("projects")
        ? { supported: true, cwd: String(params?.cwd ?? ""), count: checkpointList.length, latest: checkpointList[0] }
        : { supported: false, cwd: String(params?.cwd ?? ""), count: 0, latest: null };
    case "fs.resolve": return null;
    case "team.list": return on("teams", "roles") ? teamList : MISS;
    case "team.status": {
      if (!on("teams", "roles")) return MISS;
      const name = String(params["name"] ?? "");
      return name === "atlas"
        ? { spec: atlasTeam, running: 3, agents: teamLiveAgents, totalRuns: 5 }
        : { spec: docsTeam, running: 0, agents: [], totalRuns: 2 };
    }
    case "role.list": return on("teams", "roles") ? libraryRoles : MISS;
    case "project.list":
      return on("projects") ? [{ name: projectSpec.name, path: projectSpec.path, origin: null, teams: projectSpec.teams, queue: projectSpec.queue, sessions: projectSessions.length, archived: false }] : MISS;
    case "project.status": return on("projects") ? { spec: projectSpec, sessions: projectSessions, teams: [{ name: "atlas", running: 3 }] } : MISS;
    case "checkpoint.list": return on("projects") ? checkpointList : MISS;
    case "fs.list": return on("projects") ? { path: String(params["path"] ?? ""), entries: String(params["path"] ?? "") === "" ? projectRootFiles : [], truncated: false } : MISS;
    case "job.list": return jobs.map(jobWithWake);
    case "job.status": {
      const job = jobs.find((j) => j.name === params["name"]);
      return job ? jobWithWake(job) : null;
    }
    default: return MISS;
  }
}

// ── Native (Rust) computer-use commands ─────────────────────────────────────────────────────
// Stands in for the Tauri commands behind `native/computerUse` (the harness aliases that module and
// `@tauri-apps/api/core` to `window.__MARKETING_COMPUTER__`). It only ever reports status: no
// permission prompt, driver start or desktop access exists in the fixture, and an unknown command
// throws so a new native call cannot silently render as "working".
export const computerState = { running: false };

export function computerNative(command: string, _args?: Record<string, unknown>): unknown {
  switch (command) {
    case "computer_use_status":
      return { configured: true, driverSource: "bundled", running: computerState.running, autoStart: false, permissionOwner: "Chimera", accessibility: true, screenRecording: true };
    // Only the lease owner's monitor asks for this; the frame is the synthetic Atlas pricing target.
    case "computer_use_preview":
      return demoTarget();
    case "computer_use_stop":
      computerState.running = false;
      return { configured: true, driverSource: "bundled", running: false, autoStart: false, permissionOwner: "Chimera", accessibility: true, screenRecording: true };
    default:
      throw new Error(`marketing fixture: unexpected native command ${command}`);
  }
}
