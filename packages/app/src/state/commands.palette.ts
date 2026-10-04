import type { DeepLink, UiState, UiStore } from "@chimera/ui-state";
import type { KeymapRow } from "../keymap";
import { fuzzyScore } from "./commands.system";

export type PaletteMode = "all" | "commands" | "entities" | "shortcuts";
export type PaletteEntityKind = "agent" | "project" | "team" | "queue" | "task" | "workflow" | "event" | "memory" | "artifact" | "setting" | "mcpTool";
export type PaletteAvailability = { available: true } | { available: false; reason: string };

export type PaletteEntity = {
  kind: PaletteEntityKind;
  id: string;
  name: string;
  description: string;
  deepLink: DeepLink;
  aliases?: readonly string[];
  meta?: Readonly<Record<string, unknown>>;
};

export type CommandArgument =
  | { key: string; label: string; kind: "string"; required?: boolean; placeholder?: string }
  | { key: string; label: string; kind: "boolean"; required?: boolean }
  | { key: string; label: string; kind: "enum"; required?: boolean; options: readonly string[] }
  | { key: string; label: string; kind: "entity" | "entities"; required?: boolean; entityKind: PaletteEntityKind };

export type PaletteContext = { state: UiState; connected?: boolean; replayActive?: boolean; hasHandler?: (id: string) => boolean };
export type CommandDefinition = {
  id: string;
  name: string;
  description: string;
  category: string;
  keyHint?: string;
  aliases?: readonly string[];
  arguments?: readonly CommandArgument[];
  availability?: (context: PaletteContext) => PaletteAvailability;
  deepLink?: (args: Record<string, unknown>, context: PaletteContext) => DeepLink;
  run?: (args: Record<string, unknown>, context: PaletteContext) => void | Promise<void>;
};

export type PaletteResult =
  | { kind: "command"; id: string; name: string; description: string; keyHint?: string; availability: PaletteAvailability; command: CommandDefinition; rank: number }
  | { kind: "entity"; id: string; name: string; description: string; entityKind: PaletteEntityKind; entity: PaletteEntity; availability: PaletteAvailability; rank: number };

export type RpcFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export class CommandRegistry {
  readonly #commands = new Map<string, CommandDefinition>();
  register(command: CommandDefinition): void {
    if (this.#commands.has(command.id)) throw new Error(`duplicate command id: ${command.id}`);
    this.#commands.set(command.id, command);
  }
  list(): CommandDefinition[] { return [...this.#commands.values()]; }
  get(id: string): CommandDefinition | undefined { return this.#commands.get(id); }
}

const str = (value: unknown): string => typeof value === "string" ? value : "";
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

export function entitiesFromState(state: UiState): PaletteEntity[] {
  const entities: PaletteEntity[] = [];
  for (const id of state.agentOrder) {
    const a = state.agents[id];
    entities.push({ kind: "agent", id, name: a?.label || id, description: `${a?.state ?? "unknown"} agent`, deepLink: { kind: "agent", agentId: id } });
  }
  for (const raw of state.teams.items) {
    const name = str(raw["name"]); if (name) entities.push({ kind: "team", id: name, name, description: "team", deepLink: { kind: "team", name } });
  }
  for (const raw of state.queues.items) {
    const name = str(raw["name"]); if (name) entities.push({ kind: "queue", id: name, name, description: "queue", deepLink: { kind: "queue", name } });
  }
  for (const task of Object.values(state.tasks)) entities.push({ kind: "task", id: task.taskId, name: task.subject || task.taskId, description: `${task.state} · ${task.queue}`, deepLink: { kind: "task", taskId: task.taskId, queue: task.queue }, aliases: [task.taskId] });
  // the ring holds up to EVENT_BUFFER_MAX (5000) entries and this projection re-runs on every
  // store tick (a useMemo keyed on `state` in CommandPalette) — cap to the most recent 200
  // (events beyond that are Events-tab territory, not palette-catalog territory) so the catalog
  // never scales with the full ring.
  for (const event of state.events.slice(-200)) entities.push({ kind: "event", id: String(event.seq), name: event.kind, description: `event #${event.seq} · ${event.agentId}`, deepLink: { kind: "event", seq: event.seq } });
  for (const hit of state.memory.items) {
    const id = str((hit as unknown as Record<string, unknown>)["id"]); if (!id) continue;
    const text = str((hit as unknown as Record<string, unknown>)["text"]);
    entities.push({ kind: "memory", id, name: text.slice(0, 72) || id, description: `memory · ${id}`, deepLink: { kind: "memory", id } });
  }
  return entities;
}

export const SETTINGS_ENTITIES: readonly PaletteEntity[] = ["general", "accounts", "providers", "notifications", "hooks", "mcp"].map((section) => ({
  kind: "setting" as const, id: section, name: `${section} settings`, description: "settings section", deepLink: { kind: "settings", section },
}));

function records(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
  if (value && typeof value === "object") {
    for (const key of ["items", "records", "tasks", "artifacts"]) {
      const found = (value as Record<string, unknown>)[key];
      if (Array.isArray(found)) return records(found);
    }
  }
  return [];
}

/** Fan out over already-existing read RPCs. One failed domain never erases the
 * synchronous catalog; callers fence stale results with their query sequence. */
export async function searchDaemonEntities(request: RpcFn, query: string): Promise<PaletteEntity[]> {
  const calls: Array<Promise<PaletteEntity[]>> = [
    request("project.list", {}).then((v) => records(v).flatMap((r) => { const name = str(r["name"]); return name ? [{ kind: "project" as const, id: name, name, description: str(r["path"]) || "project", deepLink: { kind: "project" as const, name } }] : []; })),
    request("team.list", {}).then((v) => records(v).flatMap((r) => { const name = str(r["name"]); return name ? [{ kind: "team" as const, id: name, name, description: "team", deepLink: { kind: "team" as const, name } }] : []; })),
    request("queue.list", {}).then((v) => records(v).flatMap((r) => { const name = str(r["name"]); return name ? [{ kind: "queue" as const, id: name, name, description: "queue", deepLink: { kind: "queue" as const, name } }] : []; })),
    request("workflow.list", {}).then((v) => records(v).flatMap((r) => { const name = str(r["name"]); return name ? [{ kind: "workflow" as const, id: name, name, description: `workflow${num(r["version"]) !== null ? ` v${num(r["version"])}` : ""}`, deepLink: { kind: "workflow" as const, name } }] : []; })),
    request("memory.search", { query, limit: 50 }).then((v) => records(v).flatMap((r) => { const id = str(r["id"]); return id ? [{ kind: "memory" as const, id, name: str(r["text"]).slice(0, 72) || id, description: `memory · ${id}`, deepLink: { kind: "memory" as const, id } }] : []; })),
    request("artifact.list", {}).then((v) => records(v).flatMap((r) => { const id = str(r["id"]); return id ? [{ kind: "artifact" as const, id, name: str(r["label"]) || id, description: str(r["kind"]) || "artifact", deepLink: { kind: "artifact" as const, id, ...(str(r["taskId"]) ? { taskId: str(r["taskId"]) } : {}), ...(str(r["agentId"]) ? { agentId: str(r["agentId"]) } : {}) } }] : []; })),
  ];
  const settled = await Promise.allSettled(calls);
  return settled.flatMap((r) => r.status === "fulfilled" ? r.value : []);
}

export function keymapCommands(rows: readonly KeymapRow[]): CommandDefinition[] {
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (row.unbound || seen.has(row.action)) return [];
    seen.add(row.action);
    return [{ id: row.action, name: row.label, description: row.scope === "global" ? row.action : `${row.action} · ${row.scope}`, category: row.scope, keyHint: row.chord,
      availability: (ctx: PaletteContext): PaletteAvailability => row.scope === "global" || row.scope === ctx.state.activeTab || ctx.hasHandler?.(row.action)
        ? { available: true } : { available: false, reason: `available on ${row.scope}` } }];
  });
}

export function mergeEntities(...groups: readonly (readonly PaletteEntity[])[]): PaletteEntity[] {
  const map = new Map<string, PaletteEntity>();
  for (const entity of groups.flat()) map.set(`${entity.kind}:${entity.id}`, entity);
  return [...map.values()];
}

function rankText(query: string, name: string, description: string, aliases: readonly string[] = []): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const fields = [name, ...aliases];
  if (fields.some((x) => x.toLowerCase() === q)) return 1000;
  if (fields.some((x) => x.toLowerCase().startsWith(q))) return 700;
  const nameScore = Math.max(...fields.map((x) => fuzzyScore(q, x) ?? -Infinity));
  const descScore = fuzzyScore(q, description) ?? -Infinity;
  const score = Math.max(nameScore > -Infinity ? 100 + nameScore : -Infinity, descScore);
  return score === -Infinity ? null : score;
}

export function searchPalette(input: { query: string; mode: PaletteMode; registry: CommandRegistry; entities: readonly PaletteEntity[]; context: PaletteContext; pinned?: ReadonlySet<string>; recent?: readonly string[] }): PaletteResult[] {
  const out: PaletteResult[] = [];
  if (input.mode !== "entities") for (const command of input.registry.list()) {
    const rank = rankText(input.query, command.name, command.description, command.aliases); if (rank === null) continue;
    const availability = command.availability?.(input.context) ?? { available: true as const };
    const id = `command:${command.id}`;
    out.push({ kind: "command", id, name: command.name, description: command.description, ...(command.keyHint ? { keyHint: command.keyHint } : {}), availability, command, rank: rank + (input.pinned?.has(id) ? 80 : 0) + Math.max(0, 20 - (input.recent?.indexOf(id) ?? 99)) });
  }
  if (input.mode !== "commands" && input.mode !== "shortcuts") for (const entity of input.entities) {
    const rank = rankText(input.query, entity.name, entity.description, [entity.id, ...(entity.aliases ?? [])]); if (rank === null) continue;
    const id = `entity:${entity.kind}:${entity.id}`;
    out.push({ kind: "entity", id, name: entity.name, description: entity.description, entityKind: entity.kind, entity, availability: { available: true }, rank: rank + (input.pinned?.has(id) ? 80 : 0) + Math.max(0, 20 - (input.recent?.indexOf(id) ?? 99)) });
  }
  return out.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
}

export function validateArguments(definition: CommandDefinition, values: Record<string, unknown>): string | null {
  for (const arg of definition.arguments ?? []) {
    const value = values[arg.key];
    if (arg.required && (value === undefined || value === "" || (Array.isArray(value) && value.length === 0))) return `${arg.label} is required`;
    if (arg.kind === "enum" && value !== undefined && value !== "" && !arg.options.includes(String(value))) return `${arg.label} is invalid`;
    if (arg.kind === "entities" && value !== undefined && !Array.isArray(value)) return `${arg.label} must be a list`;
  }
  return null;
}

export async function executePaletteResult(result: PaletteResult, args: Record<string, unknown>, context: PaletteContext, store: UiStore): Promise<void> {
  if (!result.availability.available) throw new Error(result.availability.reason);
  if (result.kind === "entity") { store.dispatch({ type: "navigate", target: result.entity.deepLink }); return; }
  const error = validateArguments(result.command, args); if (error) throw new Error(error);
  if (result.command.deepLink) store.dispatch({ type: "navigate", target: result.command.deepLink(args, context) });
  else if (result.command.run) await result.command.run(args, context);
  else throw new Error(`command has no executor: ${result.command.id}`);
}

export const BLOCKED_TASK_ASSIGNMENT: CommandDefinition = {
  id: "tasks.assignBlocked", name: "Assign blocked tasks to team", description: "Requires a task assignment RPC", category: "tasks",
  arguments: [{ key: "tasks", label: "Blocked tasks", kind: "entities", entityKind: "task", required: true }, { key: "team", label: "Team", kind: "entity", entityKind: "team", required: true }],
  availability: () => ({ available: false, reason: "Task assignment is not supported by the daemon yet" }),
};
