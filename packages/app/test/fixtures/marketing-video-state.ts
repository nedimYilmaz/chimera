// Video-only layer over the screenshot fixture (scripts/marketing-video.mjs). It wraps the composed
// fixture RPC that marketing-boot.ts installed and adds only what a usage clip needs on top of the
// static screenshot data: a queue that changes state (push -> in progress -> done) and a memory
// search that actually filters. Everything is synthetic "Atlas website" data; nothing reaches a
// daemon, provider, account or the network. Import it SECOND (after ./marketing-boot, before
// ./marketing) so the real screens only ever see the wrapped RPC.
import { emptyCanvasLayout, type ContextLinkView } from "@chimera/protocol";
import { ids } from "./marketing-data";

type Params = Record<string, unknown>;
type Rpc = (method: string, params?: Params) => unknown;
type Task = Record<string, unknown> & { taskId: string; state: string };

const seam = window as unknown as { __MARKETING_RPC__: Rpc; __CHIMERA_MOCK__: { rpc: Rpc } };
const base = seam.__MARKETING_RPC__;

// The clock the capture script pins (Date is frozen in the page) - used for every timestamp this
// layer mints, so a recapture produces identical pixels.
const now = () => Date.now();

/** RPC methods the base fixture did not know. Fail closed: a miss is recorded AND thrown, so a scene
 * that silently rendered an empty panel can never be filmed (the capture script asserts this is []). */
export const misses: string[] = [];
const baseWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (args[0] === "marketingRpc miss") misses.push(String(args[1]));
  else baseWarn(...args);
};

const taskPatches = new Map<string, Record<string, unknown>>();
const pushed: Task[] = [];
const PUSHED_ID_BASE = 0xd1e5a7c3;

const withPatch = (t: Task): Task => ({ ...t, ...(taskPatches.get(t.taskId) ?? {}) });

function counts(tasks: Task[]): Record<string, number> {
  const c: Record<string, number> = { pending: 0, blocked: 0, in_progress: 0, done: 0, failed: 0 };
  for (const t of tasks) c[t.state] = (c[t.state] ?? 0) + 1;
  return c;
}

function queueStatus(params: Params): unknown {
  const detail = structuredClone(base("queue.status", params)) as { spec: { name: string }; counts: Record<string, number>; tasks: Task[] };
  if (detail.spec.name !== "atlas-release") return detail;
  detail.tasks = [...detail.tasks, ...pushed].map(withPatch);
  detail.counts = counts(detail.tasks);
  return detail;
}

function queuePush(params: Params): unknown {
  const tags = typeof params.tags === "string" ? params.tags.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(params.tags) ? params.tags : [];
  const taskId = (PUSHED_ID_BASE + pushed.length).toString(16);
  const at = now();
  pushed.push({
    taskId,
    queue: String(params.queue),
    state: "pending",
    role: typeof params.role === "string" && params.role ? params.role : "builder",
    priority: typeof params.priority === "number" ? params.priority : 5,
    orderKey: 0xffff00 + pushed.length,
    prompt: String(params.prompt ?? ""),
    attempts: 0,
    agentId: null,
    pushedAt: at,
    pushedBy: null,
    createdAt: at,
    startedAt: null,
    endedAt: null,
    error: null,
    tags,
    dependsOn: [],
    overrides: {},
  });
  return { taskId, state: "pending" };
}

// Query-aware search over the same records the screenshot fixture serves: every whitespace token must
// appear in the title, body, tags or folder; title hits rank first (stable otherwise).
function memorySearch(params: Params): unknown {
  const all = base("memory.search", params) as Array<{ record: { title: string; text: string; tags: string[]; folder: string }; score: number }>;
  const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
  const folder = typeof params.folder === "string" ? params.folder : "";
  const tokens = query.split(/\s+/).filter(Boolean);
  return all
    .filter((hit) => !folder || hit.record.folder === folder || hit.record.folder.startsWith(`${folder}/`))
    .map((hit) => {
      const title = hit.record.title.toLowerCase();
      const hay = `${title} ${hit.record.text.toLowerCase()} ${hit.record.tags.join(" ").toLowerCase()} ${hit.record.folder.toLowerCase()}`;
      return { hit, match: tokens.every((tok) => hay.includes(tok)), titleHits: tokens.filter((tok) => title.includes(tok)).length };
    })
    .filter((x) => x.match)
    .map((x, i) => ({ x, i }))
    .sort((a, b) => b.x.titleHits - a.x.titleHits || a.i - b.i)
    .map(({ x }) => ({ record: x.hit.record, score: tokens.length === 0 ? 1 : 0.5 + x.titleHits / (2 * tokens.length) }));
}

// Capture-only scripted services; production components validate these protocol shapes.
const links: ContextLinkView[] = [];
let canvasLayout = emptyCanvasLayout();
let canvasRevision = 0;
function videoRpc(method: string, p: Params): { value: unknown } | null {
  if (method === "issues.sourceList" || method === "issues.linkList") return { value: [] };
  if (method === "stt.status") return { value: { preferences: { v: 1, engine: null, language: "en" }, engines: [], install: { state: "idle", progress: 0 }, model: { id: "small-q5_1", bytes: 1, sha256: "0".repeat(64), license: "MIT", runtimeVersion: "demo", runtimeSha256: "0".repeat(64), path: "/demo/stt/model" } } };
  if (method === "agent.notesGet") return { value: { text: "", updatedAt: null } };
  if (method === "sub.list") return { value: [] };
  if (["contextlink.create", "contextlink.list", "contextlink.get", "contextlink.revoke"].includes(method)) {
    if (method === "contextlink.create") {
      const text = String(p.text ?? "Atlas release: use WebP hero assets; retain the accessibility checks.");
      const row: ContextLinkView = { id: "11111111-1111-4111-8111-111111111111", from: p.from as ContextLinkView["from"], toAgentId: String(p.toAgentId), createdBy: "operator", createdAt: now(), expiresAt: p.expiresAt as number | null, revokedAt: null, snapshot: { title: String(p.title), bytes: new TextEncoder().encode(text).length, sha256: "0".repeat(64), text }, status: "active", semantics: "snapshot", untrusted: false };
      links.push(row); return { value: row };
    }
    if (method === "contextlink.list") return { value: { links: links.filter(r => r.toAgentId === p.toAgentId || r.from.ref === p.fromAgentId).map(r => ({ ...r, snapshot: { ...r.snapshot, text: undefined } })) } };
    const row = links.find(r => r.id === p.id);
    if (!row || row.status !== "active") throw new Error("Snapshot unavailable");
    if (method === "contextlink.revoke") { row.status = "revoked"; row.revokedAt = now(); delete row.snapshot.text; }
    return { value: row };
  }
  if (method === "agent.resources") return { value: {
    sample: { agentId: String(p.agentId), sampledAt: now(), state: "ok", rootPid: 4200,
      procs: [{ pid: 4200, ppid: 1, name: "codex-demo", role: "agent", cpuPct: 12.4, rssBytes: 184 * 1024 ** 2, elapsedSec: 90 }, { pid: 4201, ppid: 4200, name: "node-demo", role: "tool", cpuPct: 3.1, rssBytes: 48 * 1024 ** 2, elapsedSec: 45 }],
      totals: { cpuPct: 15.5, rssBytes: 232 * 1024 ** 2, procCount: 2 }, truncated: false },
    admission: { running: 6, cap: 6, ceiling: 8, healthy: true, cpuPressure: true, memPressure: false, load1: 8, cores: 8, freeMemGb: 3, explain: "load 8/8 cores, 3 GB free" }
  } };
  if (method === "canvas.get") return { value: { revision: canvasRevision, layout: canvasLayout, nodes: [
    { ref: "agent:atlas-source", entityId: ids.conductor, agentId: ids.conductor, kind: "agent", label: "Atlas conductor", status: "running" },
    { ref: "agent:atlas-builder", entityId: ids.pricing, agentId: ids.pricing, kind: "agent", label: "Pricing page builder", status: "running" },
    { ref: "context-link:atlas-note", entityId: "11111111-1111-4111-8111-111111111111", agentId: ids.pricing, kind: "context-link", label: "Release context snapshot", status: "active" },
    { ref: "task:atlas-task", entityId: "6b83d0e4", queue: "atlas-release", kind: "task", label: "Accessibility review", status: "done" }
  ], edges: [{ from: "agent:atlas-source", to: "agent:atlas-builder", kind: "fork", label: "snapshot branch" }, { from: "context-link:atlas-note", to: "agent:atlas-builder", kind: "context", label: "explicit snapshot" }], truncated: false, readOnly: false } };
  if (method === "canvas.saveLayout") { canvasLayout = p.layout as typeof canvasLayout; return { value: { revision: ++canvasRevision } }; }
  return null;
}

const wrapped: Rpc = (method, params = {}) => {
  const before = misses.length;
  let answer: unknown;
  if (method === "queue.status") answer = queueStatus(params);
  else if (method === "queue.push") answer = queuePush(params);
  else if (method === "memory.search") answer = memorySearch(params);
  else { const video = videoRpc(method, params); answer = video ? video.value : base(method, params); }
  if (misses.length > before) throw new Error(`marketing-video fixture has no answer for ${method}`);
  return answer;
};
seam.__MARKETING_RPC__ = wrapped;
seam.__CHIMERA_MOCK__ = { rpc: async (method, params) => wrapped(method, params) };

type StoreLike = {
  dispatch(action: unknown): void;
  getState(): { lastSeq: number };
};

/** Test/capture handles, installed by marketing-video.tsx once the real store exists. */
export function installVideoHooks(store: StoreLike): void {
  const hooks = {
    misses: () => [...misses],
    /** Move a queue task to a new state and tell the real UI the way the daemon does: one per-transition
     * `status` event on the `task:<id>` coordination id. Queues/Teams refetch on exactly that event, so
     * the screen re-renders through its own refresh path, not a hand-set DOM. */
    transition(taskId: string, state: "pending" | "in_progress" | "done" | "failed"): void {
      const at = now();
      const patch: Record<string, unknown> = { state };
      if (state === "in_progress") Object.assign(patch, { startedAt: at, agentId: ids.pricing, attempts: 1 });
      else if (state !== "pending") Object.assign(patch, { endedAt: at });
      // "pending" is the push announcement: the fixture has no daemon to emit it, and the screens only
      // refetch on a coordination event, so it is sent with the state the pushed task already has.
      taskPatches.set(taskId, { ...(taskPatches.get(taskId) ?? {}), ...patch });
      store.dispatch({
        type: "event",
        stampTs: true,
        event: { seq: store.getState().lastSeq + 1, ts: at, engineId: "local", agentId: `task:${taskId}`, kind: "status", data: { taskId, queue: "atlas-release", state } },
      });
    },
    pushedTaskIds: () => pushed.map((t) => t.taskId),
  };
  (window as unknown as { __MARKETING_VIDEO__: typeof hooks }).__MARKETING_VIDEO__ = hooks;
}
