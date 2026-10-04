// W7 — PURE selectors/formatters for the Projects screen, the A2A comms feed
// and the Plugins card. Same discipline as selectors.coord.ts: plain functions
// over loosely-typed daemon payloads (project.list / project.status /
// plugins.list) and the NormalizedEvent ring — no React, no store import,
// fully unit-testable. Contracts: design/coverage.html §B12-B13; visuals: the
// mock's s_projects / showA2A / showPlugins blocks.
import type { NormalizedEvent } from "@chimera/protocol";
import type { UnseenCounts } from "@chimera/ui-state";
import { COORD_NAME_RE, ellipsize, firstLine, num, str } from "./selectors.coord";

// ---------------------------------------------------------------------------
// B1 badge — the TopBar pill total over ui-state's unseen counters
// ---------------------------------------------------------------------------

export function unseenTotal(u: UnseenCounts): number {
  return u.permissions + u.questions + u.errors;
}

// ---------------------------------------------------------------------------
// projects list (B12) — project.list items are ProjectSpec & { sessions }
// (engine.ts stamps the live running/paused session count on the list reply)
// ---------------------------------------------------------------------------

export type ProjectRow = {
  name: string;
  path: string;
  origin: string | null;     // git URL when imported (list row shows "⇣ git import")
  teams: string[];
  queue: string | null;
  sessions: number;          // LIVE sessions under the path (engine-stamped)
  archived: boolean;
};

export function projectRow(item: Record<string, unknown>): ProjectRow {
  return {
    name: str(item["name"]),
    path: str(item["path"]),
    origin: typeof item["origin"] === "string" ? (item["origin"] as string) : null,
    teams: Array.isArray(item["teams"]) ? (item["teams"] as unknown[]).filter((t): t is string => typeof t === "string") : [],
    queue: typeof item["queue"] === "string" ? (item["queue"] as string) : null,
    sessions: num(item["sessions"]),
    archived: item["archived"] === true,
  };
}

/** Free-text filter for the master list (name + path, case-insensitive) — the
 * SearchBox above the list; the cursor indexes into this filtered result,
 * never the raw `items`, so search can never desync selection from what's
 * actually visible. */
export function filterProjects(items: ProjectRow[], query: string): ProjectRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
}

/** Mock status column (rows 501/504/507): ● active (sessions>0) / idle /
 * ◌ paused (archived — the only paused state the daemon models). */
export function projectStatus(p: Pick<ProjectRow, "sessions" | "archived">): { glyph: string; word: string; tone: "success" | "warn" | "faint" } {
  if (p.archived) return { glyph: "◌", word: "paused", tone: "warn" };
  if (p.sessions > 0) return { glyph: "●", word: "active", tone: "success" };
  return { glyph: "", word: "idle", tone: "faint" };
}

// ---------------------------------------------------------------------------
// sessions table (B12) — project.status sessions are full AgentRecords
// ---------------------------------------------------------------------------

export type SessionRow = {
  agentId: string;
  state: string;
  conductor: boolean;
  team: string | null;
  role: string | null;
  branch: string | null;     // AgentRecord.gitBranch (WD Stage 1)
  activity: string;          // resultText first line / spec prompt fallback
};

export function sessionRow(rec: Record<string, unknown>): SessionRow {
  const membership = rec["membership"] && typeof rec["membership"] === "object" ? (rec["membership"] as Record<string, unknown>) : null;
  const spec = rec["spec"] && typeof rec["spec"] === "object" ? (rec["spec"] as Record<string, unknown>) : null;
  const result = typeof rec["resultText"] === "string" ? (rec["resultText"] as string).trim() : "";
  const prompt = spec && typeof spec["prompt"] === "string" ? (spec["prompt"] as string) : "";
  return {
    agentId: str(rec["agentId"]),
    state: str(rec["state"]) || "unknown",
    // WORKFLOW-TASK-VIEW-2 (bug B): scheduler.ts forces spec.conductor:true on
    // every workflow-bound task spawn too (D12 session-liveness hack) — only
    // trust it as conductor DISPLAY identity when the record carries no team
    // membership (mirrors the same gate in ui-state's reducer.ts).
    conductor: spec?.["conductor"] === true && !membership,
    team: membership && typeof membership["team"] === "string" ? (membership["team"] as string) : null,
    role: membership && typeof membership["role"] === "string" ? (membership["role"] as string) : null,
    branch: typeof rec["gitBranch"] === "string" ? (rec["gitBranch"] as string) : null,
    activity: result ? ellipsize(firstLine(result)) : prompt ? ellipsize(firstLine(prompt)) : "—",
  };
}

/** The newest seq among session-relevant events — the Projects screen's
 * refresh trigger (tab entry + relevant events, NO polling timers). Extends
 * the coord screens' status/result set with agent_started (a fresh session
 * must appear) and error (a dying one must update). 0 when none. */
export function latestSessionSeq(events: ReadonlyArray<Pick<NormalizedEvent, "seq" | "kind">>): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const k = events[i]!.kind;
    if (k === "status" || k === "result" || k === "agent_started" || k === "error") return events[i]!.seq;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// import/new form (B12)
// ---------------------------------------------------------------------------

// PROJECT-CREATE-GITINIT-OPTION: gitInit is optional in the form shape (undefined
// behaves as the default true, mirroring the daemon's own default) so existing
// call sites/tests that omit it are unaffected.
// PROJECT-CREATE-PERMISSION-PROFILE: permissionProfile is likewise optional — undefined
// means "no override, fall back to global config" (ProjectSpecSchema's own null default),
// same convention as gitInit's undefined-means-daemon-default.
export type ImportFormValues = {
  source: string; name: string; team: string; gitInit?: boolean;
  permissionProfile?: "readOnly" | "acceptEdits" | "full";
  conductorAccount?: string;
  conductorModel?: string;
};

/** First validation error, or null when submittable. Mirrors the daemon's
 * ProjectName/CoordName constraint client-side so the inline error is instant;
 * the daemon derives the name from the source when the field is left empty.
 * PROJECT-DEFAULT-DIR: `source` is now itself optional — leaving it empty (with
 * a name given) is a BLANK project create, resolved server-side under the
 * configured import dir instead of a clone/register. */
export function validateImportForm(v: ImportFormValues): string | null {
  const source = v.source.trim(), name = v.name.trim();
  if (!source && !name) return "source or name is required";
  if (name && !COORD_NAME_RE.test(name)) return "name: letters, digits, _ and - only";
  return null;
}

/** true when the form describes a blank (no-source) project.create rather than
 * a project.import — the routing decision the submit handler needs. */
export function isBlankProjectForm(v: ImportFormValues): boolean {
  return !v.source.trim();
}

/** project.import params (engine ProjectImportParams: source, name?, team?, permissionProfile?). */
export function buildImportParams(v: ImportFormValues): Record<string, unknown> {
  return {
    source: v.source.trim(),
    ...(v.name.trim() ? { name: v.name.trim() } : {}),
    ...(v.team.trim() ? { team: v.team.trim() } : {}),
    // only send permissionProfile when the operator actually picked one — undefined
    // means "no override", same convention as gitInit below.
    ...(v.permissionProfile ? { permissionProfile: v.permissionProfile } : {}),
    ...(v.conductorAccount?.trim() ? { conductorAccount: v.conductorAccount.trim() } : {}),
    ...(v.conductorModel?.trim() ? { conductorModel: v.conductorModel.trim() } : {}),
  };
}

/** project.create params for the blank-project (no source) path — `path` is
 * omitted so the daemon defaults it under config.projectImportDir/<name>
 * (PROJECT-DEFAULT-DIR). `team` (singular, import-form shape) becomes
 * project.create's `teams` array. */
export function buildCreateParams(v: ImportFormValues): Record<string, unknown> {
  return {
    name: v.name.trim(),
    ...(v.team.trim() ? { teams: [v.team.trim()] } : {}),
    // only send gitInit when it deviates from the daemon's own default (true) —
    // keeps the common case's params minimal, same convention as team/queue.
    ...(v.gitInit === false ? { gitInit: false } : {}),
    ...(v.permissionProfile ? { permissionProfile: v.permissionProfile } : {}),
    ...(v.conductorAccount?.trim() ? { conductorAccount: v.conductorAccount.trim() } : {}),
    ...(v.conductorModel?.trim() ? { conductorModel: v.conductorModel.trim() } : {}),
  };
}

// ---------------------------------------------------------------------------
// PROJECT-CONDUCTOR-ACCOUNT — the detail pane's conductor account/model pin
// ---------------------------------------------------------------------------

export type ConductorAccountPin = {
  /** the project's pinned account name, null when unpinned ("auto"). */
  account: string | null;
  /** the pinned model, null when unpinned (the provider's own default). */
  model: string | null;
  /** the project's permissionProfile, null = fall back to the global conductor
   * default ("full"). Account changes preserve this explicit profile. */
  permissionProfile: string | null;
  /** the LIVE conductor's account, null when no conductor is running. */
  liveAccount: string | null;
  /** true when a live conductor disagrees with the pin — the pin only ever
   * applies to a FRESH spawn, so the UI has to say "stop & start" out loud or
   * the operator reads the saved pin as "already applied". */
  restartRequired: boolean;
};

/** Derives the pin row from project.status's `spec` + its `sessions`
 * AgentRecords. The live conductor's account is read off the session whose
 * agentId is spec.conductorId — deliberately NOT off `conductor` (engine's
 * projectConductorInfo is {agentId,state} only, and a strict-equality test in
 * core pins that shape). A cleared pin never asks for a restart: what "auto"
 * resolves to isn't knowable client-side without routing a spawn. */
export function conductorAccountPin(
  spec: Record<string, unknown>,
  sessions: ReadonlyArray<Record<string, unknown>>,
): ConductorAccountPin {
  const account = typeof spec["conductorAccount"] === "string" ? (spec["conductorAccount"] as string) : null;
  const model = typeof spec["conductorModel"] === "string" ? (spec["conductorModel"] as string) : null;
  const permissionProfile = typeof spec["permissionProfile"] === "string" ? (spec["permissionProfile"] as string) : null;
  const conductorId = typeof spec["conductorId"] === "string" ? (spec["conductorId"] as string) : null;
  const rec = conductorId ? sessions.find((r) => r["agentId"] === conductorId) : undefined;
  const liveState = rec ? str(rec["state"]) : "";
  const alive = liveState === "running" || liveState === "paused";
  const liveAccount = rec && alive && typeof rec["accountName"] === "string" ? (rec["accountName"] as string) : null;
  const liveModel = rec && alive && typeof (rec["spec"] as Record<string, unknown> | undefined)?.["model"] === "string"
    ? ((rec["spec"] as Record<string, unknown>)["model"] as string)
    : null;
  const restartRequired = liveAccount !== null
    && ((account !== null && liveAccount !== account) || (model !== null && liveModel !== model));
  return { account, model, permissionProfile, liveAccount, restartRequired };
}

// ---------------------------------------------------------------------------
// A2A feed (B13) — derived CLIENT-SIDE from the event ring, no RPC (per the
// coverage footer: "event stream'den türetilebilir, yeni RPC gerektirmez").
// Three honest sources:
//   * status{delivered:true, from} — a deliverTo/agent_send delivery into a
//     mailbox. from ∈ {"tui","app","assign","ask"} are NON-agent senders (human,
//     scheduler, the ask-delivery echo) and are skipped — "ask" is skipped
//     because the SAME exchange is already captured structurally by its
//     agent_question event below.
//   * agent_question{to} — an ask_agent/ask_team question from e.agentId to
//     data.to (the event's agentId IS the asker; see supervisor.ask).
//   * tool_call answer_question — the target agent answering; the receiver is
//     resolved from the questionId → asker map built while scanning (an
//     unmatched qid — e.g. a human's ask_human — yields no exchange).
// ---------------------------------------------------------------------------

export type A2AKind = "send" | "question" | "answer";
export type A2AExchange = { seq: number; ts: number; from: string; to: string; kind: A2AKind; text: string };

export const A2A_FEED_MAX = 8;
const NON_AGENT_FROM = new Set(["tui", "app", "assign", "ask", "?"]);

export function a2aFeed(events: ReadonlyArray<NormalizedEvent>, max = A2A_FEED_MAX): A2AExchange[] {
  const qidAsker = new Map<string, string>();
  const out: A2AExchange[] = [];
  for (const e of events) {
    if (e.kind === "agent_question") {
      const qid = str(e.data["questionId"]);
      if (qid) qidAsker.set(qid, e.agentId);
      const to = typeof e.data["to"] === "string" ? (e.data["to"] as string) : null;
      if (to && to !== e.agentId) {
        out.push({ seq: e.seq, ts: e.ts, from: e.agentId, to, kind: "question", text: ellipsize(firstLine(str(e.data["prompt"])), 80) });
      }
    } else if (e.kind === "tool_call") {
      const toolName = str(e.data["toolName"]);
      if (!/(^|__)answer_question$/.test(toolName)) continue;
      const input = e.data["input"] && typeof e.data["input"] === "object" ? (e.data["input"] as Record<string, unknown>) : {};
      const asker = qidAsker.get(str(input["questionId"]));
      if (asker && asker !== e.agentId) {
        const text = str(input["text"]) || (Array.isArray(input["optionIds"]) ? (input["optionIds"] as unknown[]).map(String).join(", ") : "answered");
        out.push({ seq: e.seq, ts: e.ts, from: e.agentId, to: asker, kind: "answer", text: ellipsize(firstLine(text), 80) });
      }
    } else if (e.kind === "status" && e.data["delivered"] === true) {
      const from = str(e.data["from"]);
      if (from && !NON_AGENT_FROM.has(from) && from !== e.agentId) {
        out.push({ seq: e.seq, ts: e.ts, from, to: e.agentId, kind: "send", text: ellipsize(firstLine(str(e.data["text"])), 80) });
      }
    }
  }
  return out.slice(-max).reverse();   // latest-N ring, newest FIRST (ticker order)
}

/** Pairs active within the pulse window (~3s) — drives the AgentList's ↗/↘
 * one-shot markers. Pure over an injected `now` so tests never race. */
export function activeA2APairs(feed: ReadonlyArray<A2AExchange>, now: number, windowMs = 3000): A2AExchange[] {
  return feed.filter((x) => now - x.ts >= 0 && now - x.ts <= windowMs);
}

/** The pulse marker an agent row wears for the active window: the SENDER of
 * the most recent active exchange wins over receiver when an agent is both. */
export function a2aRole(active: ReadonlyArray<A2AExchange>, agentId: string): "sender" | "receiver" | null {
  if (active.some((x) => x.from === agentId)) return "sender";
  if (active.some((x) => x.to === agentId)) return "receiver";
  return null;
}

/** Mock's ticker age cell ("2s" / "41s" / "3m"). */
export function fmtAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

// ---------------------------------------------------------------------------
// plugins & commands card (B13) — plugins.list catalog + the selected agent's
// spawn-spec skills (AgentView.skills, advertised via system/init)
// ---------------------------------------------------------------------------

export type PluginRowView = {
  id: string;                // "<kind>:<name>" — plugins.toggle key
  kind: string;              // skill | plugin | command
  name: string;              // command rows render as "/name" (mock 399)
  scope: string;             // "global" | "proje · <name>" | "agent · <name>"
  source: string;
  enabled: boolean;
};

/** plugins.list entries → card rows. Command rows are project-scoped: the
 * caller passes the label of the project whose cwd fed the {cwd} param. */
export function catalogRows(entries: ReadonlyArray<Record<string, unknown>>, projectLabel: string | null): PluginRowView[] {
  return entries.map((e) => {
    const kind = str(e["kind"]);
    return {
      id: str(e["id"]),
      kind,
      name: str(e["name"]),
      scope: kind === "command" ? `proje · ${projectLabel ?? "?"}` : "global",
      source: str(e["source"]),
      enabled: e["enabled"] !== false,
    };
  }).filter((r) => r.id && r.name);
}

/** The selected agent's spawn-spec skills as agent-scope rows (mock 400:
 * "dataviz · skill · agent · eager-weasel · spawn spec"), minus any name the
 * global catalog already lists (one row per skill, catalog wins). Their ids
 * still key plugins.toggle (the registry accepts any well-formed id), so
 * space works here too — applying to NEW spawns like every toggle. */
export function agentSkillRows(
  skills: ReadonlyArray<string> | undefined,
  agentLabel: string,
  catalog: ReadonlyArray<PluginRowView>,
  overrides: Readonly<Record<string, boolean>> = {},
): PluginRowView[] {
  const seen = new Set(catalog.filter((r) => r.kind === "skill").map((r) => r.name));
  return (skills ?? []).filter((s) => !seen.has(s)).map((name) => ({
    id: `skill:${name}`,
    kind: "skill",
    name,
    scope: `agent · ${agentLabel}`,
    source: "spawn spec",
    // plugins.list only catalogs GLOBAL entries, so a spawn-spec skill's toggle
    // state can't be re-read from the daemon — the session-local `overrides`
    // map (fed by each plugins.toggle reply) keeps the row honest after a space.
    enabled: overrides[`skill:${name}`] ?? true,
  }));
}

/** Slash-popup extras (B13: "/deploy komutu popup'ta görünür ve agent'a
 * gider"): the ENABLED project commands matching the popup's current query,
 * minus names an advertised entry already covers (a real SDK agent advertises
 * its project commands itself via system/init — these extras are the fallback
 * path). Prefix match mirrors filterSlashEntries. */
export function projectCommandEntries(
  catalog: ReadonlyArray<PluginRowView>,
  query: string,
  advertisedNames: ReadonlyArray<string>,
): PluginRowView[] {
  const taken = new Set(advertisedNames);
  const q = query.toLowerCase();
  return catalog.filter(
    (r) => r.kind === "command" && r.enabled && !taken.has(r.name) && r.name.toLowerCase().startsWith(q),
  );
}
