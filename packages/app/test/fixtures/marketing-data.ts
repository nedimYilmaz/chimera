// Synthetic DEMO data for the marketing screenshot harness (scripts/marketing-preview.mjs).
// "Atlas website" is a fictional project: every agent, task, note and number below is invented,
// nothing is read from a daemon, account, provider or filesystem, and no figure is a benchmark.
// Timestamps are relative to page load so relative-time labels read naturally at capture time.

export const NOW = Date.now();
export const ago = (minutes: number) => NOW - Math.round(minutes * 60_000);

export const DEMO_CWD = "/demo/atlas-website";

export const ids = {
  conductor: "c0d7e5a1-3b6f-4d92-8e14-7a52b9f0c316",
  pricing: "9e41b7d3-52c8-4f0a-b6e7-1d3a8c45f290",
  a11y: "5fa2c8e6-17d4-4b39-a0c1-e86d2f7b3954",
  docs: "b13d6f08-9a7e-4c25-85f3-2e0c71a4d6b8",
  notes: "e7c29a54-0d3b-48f1-9c6a-4b85d1e3f072",
};

const cost = { conductor: 1.84, pricing: 0.92, a11y: 0.47, docs: 0.31, notes: 0.18 };

export const agentRecords = [
  { agentId: ids.conductor, state: "running", accountName: "claude-demo", provider: "claude", permissionProfile: "acceptEdits", costUsd: cost.conductor, createdAt: ago(96), treeId: ids.conductor, depth: 0, membership: { team: "atlas" }, spec: { displayLabel: "Atlas conductor", model: "claude-opus-5-5", cwd: DEMO_CWD, role: "conductor", prompt: "Ship the Atlas pricing page." } },
  { agentId: ids.pricing, state: "running", accountName: "codex-demo", provider: "codex", permissionProfile: "acceptEdits", costUsd: cost.pricing, createdAt: ago(71), treeId: ids.conductor, depth: 1, membership: { team: "atlas" }, spec: { displayLabel: "Pricing page builder", model: "gpt-6-sol", cwd: DEMO_CWD, role: "builder", prompt: "Build the plan comparison table." } },
  { agentId: ids.a11y, state: "running", accountName: "codex-demo", provider: "codex", permissionProfile: "readOnly", costUsd: cost.a11y, createdAt: ago(48), treeId: ids.conductor, depth: 1, membership: { team: "atlas" }, spec: { displayLabel: "Accessibility auditor", model: "gpt-6-astra", cwd: DEMO_CWD, role: "auditor", prompt: "Audit the pricing page against WCAG 2.2 AA." } },
  { agentId: ids.docs, state: "done", accountName: "claude-demo", provider: "claude", permissionProfile: "readOnly", costUsd: cost.docs, createdAt: ago(88), treeId: ids.conductor, depth: 1, membership: { team: "atlas" }, spec: { displayLabel: "Docs reviewer", model: "claude-sonnet-5-5", cwd: DEMO_CWD, role: "reviewer", prompt: "Review pricing copy against the brand guide." } },
  { agentId: ids.notes, state: "done", accountName: "claude-demo", provider: "claude", permissionProfile: "acceptEdits", costUsd: cost.notes, createdAt: ago(64), treeId: ids.conductor, depth: 1, membership: { team: "atlas" }, spec: { displayLabel: "Release notes writer", model: "claude-sonnet-5-5", cwd: DEMO_CWD, role: "writer", prompt: "Draft the Atlas 2.4 release notes." } },
];

export const daemonStatus = {
  protocolVersion: 1,
  agents: { running: 3, paused: 0, done: 2, failed: 0, killed: 0 },
  accounts: [
    { name: "claude-demo", provider: "claude" },
    { name: "codex-demo", provider: "codex" },
  ],
  peers: [],
};

export const roles = [
  { name: "conductor", cwd: DEMO_CWD, permissionProfile: "acceptEdits", model: "claude-opus-5-5" },
  { name: "builder", cwd: DEMO_CWD, permissionProfile: "acceptEdits", model: "gpt-6-sol" },
  { name: "auditor", cwd: DEMO_CWD, permissionProfile: "readOnly", model: "gpt-6-astra" },
  { name: "reviewer", cwd: DEMO_CWD, permissionProfile: "readOnly", model: "claude-sonnet-5-5" },
  { name: "writer", cwd: DEMO_CWD, permissionProfile: "acceptEdits", model: "claude-sonnet-5-5" },
];

const queueSpec = { name: "atlas-release", retryLimit: 2, paused: false, createdAt: ago(100) };
const docsQueueSpec = { name: "atlas-docs", retryLimit: 1, paused: false, createdAt: ago(90) };
export const queues = [queueSpec, docsQueueSpec];

export const teams = [
  {
    name: "atlas",
    purpose: "Ship the Atlas website pricing page (demo project)",
    maxConcurrent: 3,
    queue: "atlas-release",
    roles: Object.fromEntries(roles.filter((r) => r.name !== "conductor").map((r) => [r.name, { role: r.name, overrides: { cwd: DEMO_CWD } }])),
  },
];

const task = (taskId: string, state: string, role: string, priority: number, prompt: string, extra: Record<string, unknown> = {}) => ({
  taskId,
  queue: "atlas-release",
  state,
  role,
  priority,
  orderKey: Number.parseInt(taskId.slice(0, 4), 16),
  prompt,
  attempts: 0,
  agentId: null,
  pushedAt: ago(95),
  pushedBy: ids.conductor,
  createdAt: ago(95),
  startedAt: null,
  endedAt: null,
  error: null,
  tags: [],
  dependsOn: [],
  overrides: {},
  ...extra,
});

const T = { layout: "1a4f9c02", copy: "27be5d81", table: "3c90e6a7", audit: "48d1f3b5", jsonld: "5e27a8c9", visual: "6b83d0e4", smoke: "7d15c9f2", notes: "82a6e1b8", hero: "9f3c47d0", snippets: "a4e08b63" };

export const queueTasks = [
  task(T.layout, "done", "builder", 5, "Scaffold the pricing page layout with responsive plan cards", { agentId: ids.pricing, startedAt: ago(70), endedAt: ago(52), tags: ["area:pricing"] }),
  task(T.copy, "done", "reviewer", 5, "Review pricing copy and plan names against the brand voice guide", { agentId: ids.docs, startedAt: ago(86), endedAt: ago(61), tags: ["area:copy"] }),
  task(T.table, "in_progress", "builder", 4, "Build the plan comparison table with a sticky header and an annual/monthly toggle", { agentId: ids.pricing, attempts: 0, startedAt: ago(51), tags: ["area:pricing", "gate:a11y"], dependsOn: [T.layout] }),
  task(T.audit, "in_progress", "auditor", 4, "Audit the pricing page for WCAG 2.2 AA: focus order, contrast, table semantics", { agentId: ids.a11y, startedAt: ago(40), tags: ["gate:a11y"], dependsOn: [T.layout] }),
  task(T.jsonld, "pending", "builder", 3, "Add JSON-LD offer markup for the three plans", { tags: ["area:seo"], dependsOn: [] }),
  task(T.notes, "pending", "writer", 2, "Draft release notes for the Atlas 2.4 launch", { tags: ["area:docs"], dependsOn: [T.copy] }),
  task(T.visual, "blocked", "reviewer", 3, "Final visual regression pass across the mobile, tablet and desktop breakpoints", { tags: ["gate:visual"], dependsOn: [T.table, T.audit, T.layout] }),
  task(T.smoke, "blocked", "auditor", 3, "Run the checkout-flow smoke checks against the staging build", { tags: ["gate:smoke"], dependsOn: [T.table] }),
  task(T.hero, "failed", "builder", 1, "Convert hero artwork to AVIF with a WebP fallback", { attempts: 2, agentId: ids.pricing, startedAt: ago(58), endedAt: ago(55), error: "image pipeline exited with status 2 (demo failure)", tags: ["area:assets"] }),
  task(T.snippets, "pending", "writer", 1, "Update the docs embed snippets for the new pricing widget", { tags: ["area:docs"], dependsOn: [] }),
];

const counts = (tasks: typeof queueTasks) => {
  const c: Record<string, number> = { pending: 0, blocked: 0, in_progress: 0, done: 0, failed: 0 };
  for (const t of tasks) c[t.state] = (c[t.state] ?? 0) + 1;
  return c;
};

export const queueDetails: Record<string, unknown> = {
  "atlas-release": { spec: queueSpec, counts: counts(queueTasks), tasks: queueTasks },
  "atlas-docs": {
    spec: docsQueueSpec,
    counts: { pending: 0, blocked: 0, in_progress: 0, done: 2, failed: 0 },
    tasks: [
      { ...task("b2c71e90", "done", "writer", 2, "Publish the pricing FAQ outline", { agentId: ids.notes, startedAt: ago(66), endedAt: ago(50) }), queue: "atlas-docs" },
      { ...task("c8d35a14", "done", "reviewer", 2, "Proofread the FAQ against the plan limits matrix", { agentId: ids.docs, startedAt: ago(49), endedAt: ago(42) }), queue: "atlas-docs" },
    ],
  },
};

export const teamDetail = { spec: teams[0], running: 3, agents: [ids.pricing, ids.a11y, ids.conductor], totalRuns: 5 };

// ---- transcripts ---------------------------------------------------------------------------

type Ev = { seq: number; ts: number; engineId: "local"; agentId: string; kind: string; data: Record<string, unknown> };

function transcript(agentId: string, startedMinutesAgo: number, steps: Array<[string, Record<string, unknown>]>): Ev[] {
  const span = startedMinutesAgo * 60_000;
  return steps.map(([kind, data], i) => ({
    seq: i + 1,
    ts: NOW - span + Math.round((span * (i + 1)) / (steps.length + 2)),
    engineId: "local" as const,
    agentId,
    kind,
    data,
  }));
}

const user = (text: string): [string, Record<string, unknown>] => ["status", { delivered: true, from: "app", text }];
const say = (text: string, model?: string): [string, Record<string, unknown>] => ["message_complete", { text, ...(model ? { model } : {}) }];
const call = (toolId: string, toolName: string, input: Record<string, unknown>): [string, Record<string, unknown>] => ["tool_call", { toolId, toolName, input }];
const result = (toolId: string, text: string): [string, Record<string, unknown>] => ["tool_result", { toolId, result: text }];

const conductorSteps: Array<[string, Record<string, unknown>]> = [
  user("Ship the Atlas pricing page this week: three plans, a comparison table, an accessibility pass and release notes. Check what we already decided before you split the work."),
  call("c1", "mcp__chimera__memory_search", { query: "pricing tiers brand voice plan limits" }),
  result("c1", "3 notes: Pricing tiers: Starter, Team, Scale · Brand voice guide · Plan limits matrix"),
  say("Plan: the tiers and the plan limits are already decided, so I will not reopen them.\n\n1. **Pricing page builder** (Codex) lays out the plan cards, then builds the comparison table.\n2. **Accessibility auditor** (Codex, read-only) checks the page against WCAG 2.2 AA while the table is built.\n3. **Docs reviewer** (Claude) checks the copy against the brand voice guide.\n4. **Release notes writer** (Claude) drafts the 2.4 notes once the copy is approved.\n\nI will push these to the `atlas-release` queue with dependencies so the visual regression pass cannot start before the table and the audit are done.", "claude-opus-5-5"),
  call("c2", "mcp__chimera__queue_push", { queue: "atlas-release", role: "builder", prompt: "Scaffold the pricing page layout with responsive plan cards", priority: 5 }),
  result("c2", "queued 1a4f9c02 (pending)"),
  call("c3", "mcp__chimera__queue_push", { queue: "atlas-release", role: "reviewer", prompt: "Final visual regression pass across the mobile, tablet and desktop breakpoints", dependsOn: ["3c90e6a7", "48d1f3b5", "1a4f9c02"] }),
  result("c3", "queued 6b83d0e4 (blocked: waits on 3 tasks)"),
  call("c4", "Read", { file_path: `${DEMO_CWD}/site/pricing.html` }),
  result("c4", "212 lines · three plan cards · comparison table placeholder at line 148"),
  say("The page skeleton exists and the table is the only real gap. The builder owns `pricing.html`; I am keeping the auditor read-only so it cannot race the builder on the same file.", "claude-opus-5-5"),
  call("c5", "Bash", { command: "pnpm --filter atlas-site test -- pricing", description: "Run the pricing page unit tests" }),
  result("c5", "PASS  pricing-cards.test.ts (6 tests)\nPASS  plan-limits.test.ts (4 tests)\n\nTests: 10 passed, 10 total"),
  user("Good. Which gates must be green before we merge?"),
  say("Three gates are tagged on the queue and the merge waits on all of them:\n\n- `gate:a11y` — the comparison table and the audit\n- `gate:visual` — the three-breakpoint regression pass (blocked until the table and the audit finish)\n- `gate:smoke` — the checkout-flow smoke checks against staging\n\nRight now the table build and the audit are running in parallel. One task failed: the AVIF hero conversion exited with status 2 and used both retries. I recorded that as a decision note rather than blocking the page on it — the page ships with the WebP hero and the AVIF work moves to a follow-up.", "claude-opus-5-5"),
  call("c6", "mcp__chimera__memory_add", { kind: "decision", title: "Ship WebP hero first, AVIF as follow-up", folder: "atlas/design" }),
  result("c6", "saved note · linked to Image pipeline notes"),
  say("Saved. I will check the queue again when the table task reports back.", "claude-opus-5-5"),
  ["turn_complete", {}],
];

const pricingSteps: Array<[string, Record<string, unknown>]> = [
  user("Build the plan comparison table: sticky header, annual/monthly toggle, native table semantics."),
  call("p1", "Edit", { file_path: `${DEMO_CWD}/site/pricing.html`, description: "Add the comparison table markup" }),
  result("p1", "applied 1 edit (+74 −2)"),
  say("The comparison grid is a real `<table>` with scoped column headers, as the design decision note requires. Next up: the annual/monthly toggle."),
  ["turn_complete", {}],
];

const a11ySteps: Array<[string, Record<string, unknown>]> = [
  user("Audit the pricing page against WCAG 2.2 AA. Read-only: report findings, do not edit."),
  call("a1", "Read", { file_path: `${DEMO_CWD}/site/pricing.html` }),
  result("a1", "212 lines"),
  say("Two findings so far: the plan-card CTA contrast is 3.9:1 (needs 4.5:1) and the toggle has no visible focus ring. I am continuing with the table semantics once the builder lands the markup."),
  ["turn_complete", {}],
];

const docsSteps: Array<[string, Record<string, unknown>]> = [
  user("Review the pricing copy against the brand voice guide."),
  say("Reviewed. Three edits suggested: sentence-case the headings, drop one superlative in the Scale card, and remove the uptime claim — the brand guide says never to promise uptime numbers on the marketing site. Everything else matches."),
  ["turn_complete", {}],
];

const notesSteps: Array<[string, Record<string, unknown>]> = [
  user("Draft the Atlas 2.4 release notes."),
  say("Draft written to `docs/release-notes-2.4.md`. It lists the new pricing page, the accessibility fixes and the docs snippet changes."),
  ["turn_complete", {}],
];

export const replay: Record<string, Ev[]> = {
  [ids.conductor]: transcript(ids.conductor, 62, conductorSteps),
  [ids.pricing]: transcript(ids.pricing, 48, pricingSteps),
  [ids.a11y]: transcript(ids.a11y, 36, a11ySteps),
  [ids.docs]: transcript(ids.docs, 80, docsSteps),
  [ids.notes]: transcript(ids.notes, 55, notesSteps),
};

// ---- memory --------------------------------------------------------------------------------

type Note = { id: string; title: string; kind: "note" | "decision" | "fact" | "todo" | "question"; folder: string; pinned: boolean; tags: string[]; author: string; age: number; text: string };

const notes: Note[] = [
  { id: "m-0001", title: "Pricing tiers: Starter, Team, Scale", kind: "decision", folder: "atlas/decisions", pinned: true, tags: ["pricing", "brand"], author: ids.conductor, age: 210, text: "Atlas ships three plans on the pricing page: Starter, Team and Scale. Copy follows the [[Brand voice guide]]; seat and project limits live in [[Plan limits matrix]]. The comparison grid uses [[Native table semantics for the plan grid]]." },
  { id: "m-0002", title: "Brand voice guide", kind: "fact", folder: "atlas/design", pinned: true, tags: ["brand", "copy"], author: ids.docs, age: 200, text: "Plain and confident, sentence-case headings, no superlatives. Never promise uptime numbers or benchmark figures on the marketing site. Applies to every plan card described in [[Pricing tiers: Starter, Team, Scale]]." },
  { id: "m-0003", title: "Plan limits matrix", kind: "fact", folder: "atlas/decisions", pinned: false, tags: ["pricing"], author: ids.conductor, age: 190, text: "Starter: 3 seats · Team: 15 seats · Scale: unlimited seats. Limits are demo values for this fictional project. The table on the page must match this note — see [[Pricing tiers: Starter, Team, Scale]]." },
  { id: "m-0004", title: "Native table semantics for the plan grid", kind: "decision", folder: "atlas/design", pinned: false, tags: ["a11y", "pricing"], author: ids.a11y, age: 150, text: "The comparison grid is a real <table> with scoped column headers, not a div grid with ARIA roles. The auditor flagged the div grid's focus order twice. Checklist: [[WCAG 2.2 AA checklist]]." },
  { id: "m-0005", title: "WCAG 2.2 AA checklist", kind: "note", folder: "atlas/quality", pinned: false, tags: ["a11y", "checklist"], author: ids.a11y, age: 140, text: "Focus order matches visual order · contrast 4.5:1 for body text, 3:1 for large text · visible focus ring on every control · table headers scoped. Findings feed [[Native table semantics for the plan grid]]." },
  { id: "m-0006", title: "Annual toggle default: monthly or annual?", kind: "question", folder: "atlas/decisions", pinned: false, tags: ["pricing", "open"], author: ids.pricing, age: 120, text: "Open question: should the toggle default to monthly or annual billing? Annual shows the lower per-month price but risks reading as a pre-selected upsell. Needs an owner; relates to [[Pricing tiers: Starter, Team, Scale]]." },
  { id: "m-0007", title: "Ship WebP hero first, AVIF as follow-up", kind: "decision", folder: "atlas/design", pinned: false, tags: ["assets", "perf"], author: ids.conductor, age: 55, text: "The AVIF hero conversion failed twice (image pipeline status 2). The page ships with the WebP hero and the AVIF work moves to a follow-up. Pipeline notes: [[Image pipeline notes]].\n\n**Why not block the page on it**\n\n- WebP already meets the hero budget on the three target breakpoints.\n- The converter failure is in the pipeline, not in the artwork, so retrying the same task will not change the result.\n- The visual regression pass can run today against the WebP hero.\n\n**Follow-up:** a separate task once the converter has an explicit output directory. Owner: Atlas conductor." },
  { id: "m-0008", title: "Image pipeline notes", kind: "fact", folder: "atlas/design", pinned: false, tags: ["assets"], author: ids.pricing, age: 170, text: "Hero artwork is exported at 2x, converted to WebP and, once the pipeline is fixed, AVIF. The converter needs an explicit output directory. Context: [[Ship WebP hero first, AVIF as follow-up]]." },
  { id: "m-0009", title: "Release checklist", kind: "note", folder: "atlas/ops", pinned: true, tags: ["release", "checklist"], author: ids.conductor, age: 180, text: "Before merge: gate:a11y, gate:visual and gate:smoke are all green; release notes drafted; docs snippets updated. Smoke checks run on [[Staging environment]]. Announcement copy waits on [[Launch FAQ draft]]." },
  { id: "m-0010", title: "Staging environment", kind: "fact", folder: "atlas/ops", pinned: false, tags: ["release", "ops"], author: ids.conductor, age: 175, text: "Staging deploys on every merge to the release branch. Smoke checks and the visual regression pass run against it before launch. Part of the [[Release checklist]]." },
  { id: "m-0011", title: "Add JSON-LD offer markup", kind: "todo", folder: "atlas/seo", pinned: false, tags: ["seo", "pricing"], author: ids.notes, age: 90, text: "Add schema.org Offer markup for the three plans once the table lands. Prices must match [[Plan limits matrix]] and the visible page copy." },
  { id: "m-0012", title: "Docs embed snippet conventions", kind: "note", folder: "atlas/docs", pinned: false, tags: ["docs"], author: ids.notes, age: 75, text: "Embed snippets use the plan names exactly as written in [[Pricing tiers: Starter, Team, Scale]] and never include price figures." },
];

const record = (n: Note) => ({
  id: n.id,
  author: n.author,
  text: n.text,
  title: n.title,
  folder: n.folder,
  scope: null,
  pinned: n.pinned,
  tags: n.tags,
  kind: n.kind,
  treeId: ids.conductor,
  taskId: null,
  supersedes: null,
  supersededBy: null,
  createdAt: ago(n.age + 6),
  updatedAt: ago(n.age),
});

const byTitle = new Map(notes.map((n) => [n.title, n]));
const linkTargets = (n: Note) => [...n.text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!);

function memoryGet(id: string) {
  const n = notes.find((x) => x.id === id) ?? notes[0]!;
  const links = linkTargets(n).map((target) => {
    const hit = byTitle.get(target);
    return { target, resolvedId: hit?.id ?? null, resolvedTitle: hit?.title ?? target };
  });
  const backlinks = notes
    .filter((o) => o.id !== n.id && linkTargets(o).includes(n.title))
    .map((o) => ({ id: o.id, title: o.title, kind: o.kind, folder: o.folder, snippet: o.text.slice(0, 110) }));
  return { record: record(n), links, backlinks };
}

function memoryGraph() {
  const nodes = notes.map((n) => ({ id: n.id, title: n.title, label: n.title, kind: n.kind, folder: n.folder, tags: n.tags, degree: 0, updatedAt: ago(n.age) }));
  const edges: Array<{ source: string; target: string; kind: "link"; weight: number }> = [];
  for (const n of notes) {
    for (const t of linkTargets(n)) {
      const to = byTitle.get(t);
      if (to) edges.push({ source: n.id, target: to.id, kind: "link", weight: 1 });
    }
  }
  for (const e of edges) {
    nodes.find((x) => x.id === e.source)!.degree++;
    nodes.find((x) => x.id === e.target)!.degree++;
  }
  return { nodes, edges };
}

function memoryStats() {
  const tally = (pick: (n: Note) => string) => {
    const out: Record<string, number> = {};
    for (const n of notes) out[pick(n)] = (out[pick(n)] ?? 0) + 1;
    return out;
  };
  const tagCounts = new Map<string, number>();
  for (const n of notes) for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const byFolder = Object.entries(tally((n) => n.folder)).map(([folder, count]) => ({ folder, count }));
  const pinned = notes.filter((n) => n.pinned).length;
  return {
    total: notes.length,
    byKind: tally((n) => n.kind),
    byFolder,
    byScope: [{ scope: null, count: notes.length }],
    topTags: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tag, count]) => ({ tag, count })),
    capacity: {
      limit: 500,
      total: notes.length,
      fill: notes.length / 500,
      alarmAt: 0.9,
      alarming: false,
      pinned,
      nextToEvict: notes
        .filter((n) => !n.pinned)
        .slice(-3)
        .map((n) => ({ id: n.id, title: n.title, kind: n.kind, value: 1, inbound: 0, pinned: false })),
    },
  };
}

export function marketingRpc(method: string, params: Record<string, unknown> = {}): unknown {
  switch (method) {
    case "daemon.status": return daemonStatus;
    case "agent.list": return agentRecords;
    case "agent.status": return agentRecords.find((a) => a.agentId === params.agentId) ?? agentRecords[0];
    case "agent.tail": return replay[String(params.agentId)] ?? [];
    case "events.replay": return replay[String(params.agentId)] ?? [];
    case "team.list": return teams;
    case "team.status": return teamDetail;
    case "queue.list": return queues;
    case "queue.status": return queueDetails[String(params.queue)] ?? queueDetails["atlas-release"];
    case "role.list": return roles;
    case "memory.search": return notes.map((n) => ({ record: record(n), score: 1 }));
    case "memory.stats": return memoryStats();
    case "memory.get": return memoryGet(String(params.id));
    case "memory.graph": return memoryGraph();
    case "memory.index": return { state: "ready", provider: "local", model: "demo", embedded: notes.length, total: notes.length, pending: 0 };
    case "voice.native.history": return { messages: [] };
    // Logged so the capture run can fail on a screen that silently loaded an empty panel.
    default: console.warn("marketingRpc miss", method); return [];
  }
}

export const memoryNoteIds = notes.map((n) => n.id);
