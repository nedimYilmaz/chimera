import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentGroup, AgentGroupColor } from "@chimera/protocol";

// AGENT-GROUPS Phase 1: the daemon-side registry of operator-defined wrapper-box groups
// ("sprint", "daily") — a NAMED ENTITY that OUTLIVES its members (an empty group persists;
// deletion is explicit, never automatic). Mirrors ConfigStore's sync tmp+rename JSON
// persistence exactly (packages/core/src/configstore.ts), not ModelCatalogService's async
// fetch-and-cache shape — there is no remote source here, just a small local file. A corrupt
// or missing file degrades to an empty registry and NEVER throws (same discipline as
// model-catalog.ts's loadPersisted), so a damaged groups.json can never fail daemon boot.
//
// Deliberately holds ONLY the registry (id/name/color/createdAt/order) — membership
// (AgentRecord.groups) lives on the agent record itself and is mutated via
// AgentSupervisor.setAgentGroups, mirroring renameAgent's shape. GroupStore never reads or
// writes an AgentRecord; deleting a group here never touches one (see AGENT-GROUPS test #3).

const GROUPS_FILE = "groups.json";
const MAX_GROUPS = 64;

export class GroupCapError extends Error {
  code = "protocol" as const;
  name = "GroupCapError";
  constructor() { super(`cannot create more than ${MAX_GROUPS} groups`); }
}
export class GroupNotFoundError extends Error {
  code = "protocol" as const;
  name = "GroupNotFoundError";
  constructor(id: string) { super(`unknown group: ${id}`); }
}
// A name that, once slugified, collides with every available suffix up to this bound — in
// practice unreachable (it would require MAX_GROUPS groups sharing one slug root) but kept
// as an explicit fail-fast rather than an infinite loop.
export class GroupIdExhaustedError extends Error {
  code = "protocol" as const;
  name = "GroupIdExhaustedError";
  constructor(name: string) { super(`could not derive a unique id for group name: ${name}`); }
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);
  return base.length > 0 && /^[a-z0-9]/.test(base) ? base : `group-${base}`.slice(0, 32);
}

export class GroupStore {
  private groups: AgentGroup[] = [];
  private readonly path: string;

  constructor(home: string) {
    this.path = join(home, GROUPS_FILE);
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) this.groups = parsed.filter(isPlausibleGroup);
    } catch {
      // No file yet (first boot) or a corrupt/unreadable one — start empty; the next
      // mutation persists a fresh, valid file. Never throws (see class header).
    }
  }

  private persist(): void {
    // Atomic write: tmp + rename, so a crash mid-write never leaves a torn registry (mirrors
    // configstore.ts's writeUi / model-catalog.ts's persist).
    const tmp = `${this.path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.groups, null, 2));
    renameSync(tmp, this.path);
  }

  list(): AgentGroup[] {
    return [...this.groups].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  get(id: string): AgentGroup | undefined {
    return this.groups.find((g) => g.id === id);
  }

  create(opts: { name: string; color?: AgentGroupColor; now: number }): AgentGroup {
    if (this.groups.length >= MAX_GROUPS) throw new GroupCapError();
    const name = opts.name.trim().slice(0, 48);
    const base = slugify(name);
    let id = base;
    let suffix = 2;
    while (this.groups.some((g) => g.id === id)) {
      if (suffix > MAX_GROUPS) throw new GroupIdExhaustedError(name);
      id = `${base}-${suffix}`.slice(0, 32);
      suffix++;
    }
    const order = this.groups.reduce((max, g) => Math.max(max, g.order), -1) + 1;
    const group: AgentGroup = { id, name, ...(opts.color ? { color: opts.color } : {}), createdAt: opts.now, order };
    this.groups.push(group);
    this.persist();
    return group;
  }

  update(id: string, patch: { name?: string; color?: AgentGroupColor }): AgentGroup {
    const group = this.get(id);
    if (!group) throw new GroupNotFoundError(id);
    if (patch.name !== undefined) group.name = patch.name.trim().slice(0, 48);
    if (patch.color !== undefined) group.color = patch.color;
    this.persist();
    return group;
  }

  // Idempotent: deleting an already-gone (or never-existed) id is a silent no-op, not an
  // error — a double-click / retried delete must never surface as a caller mistake. Never
  // touches an AgentRecord's `groups` field (AGENT-GROUPS test #3: a membership naming a
  // deleted group resolves-or-ignores at ui-state read time, never guessed/rewritten here).
  delete(id: string): void {
    const before = this.groups.length;
    this.groups = this.groups.filter((g) => g.id !== id);
    if (this.groups.length !== before) this.persist();
  }
}

function isPlausibleGroup(v: unknown): v is AgentGroup {
  if (!v || typeof v !== "object") return false;
  const g = v as Record<string, unknown>;
  return typeof g["id"] === "string" && typeof g["name"] === "string"
    && typeof g["createdAt"] === "number" && typeof g["order"] === "number";
}
