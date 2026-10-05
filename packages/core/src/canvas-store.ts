import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CanvasLayoutSchema, emptyCanvasLayout, type CanvasLayout } from "@chimera/protocol";
import { writeFileDurable } from "./durable-write.js";
import { rpcError } from "./rpc-error.js";

const MAX_BYTES = 256 * 1024;
const stored = z.object({ v: z.literal(1), revision: z.number().int().nonnegative(), layout: CanvasLayoutSchema }).strict();
export class CanvasStore {
  constructor(private readonly home: string) {}
  path(projectId: string): string {
    // Project names are user input; a digest keeps every layout inside the state directory.
    return join(this.home, `canvas-${createHash("sha256").update(projectId).digest("hex")}.json`);
  }
  get(projectId: string, refs: Set<string>) {
    const file = this.path(projectId);
    if (!existsSync(file)) return { revision: 0, layout: emptyCanvasLayout(), readOnly: false };
    if (statSync(file).size > MAX_BYTES) throw rpcError("protocol", "Canvas layout exceeds 256 KiB; file preserved");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown };
    if (raw.v !== 1) return { revision: 0, layout: emptyCanvasLayout(), readOnly: true };
    const value = stored.parse(raw);
    return { revision: value.revision, layout: this.prune(value.layout, refs), readOnly: false };
  }
  private prune(layout: CanvasLayout, refs: Set<string>): CanvasLayout {
    return { ...layout, positions: Object.fromEntries(Object.entries(layout.positions).filter(([ref]) => refs.has(ref))) };
  }
  save(projectId: string, baseRevision: number, input: CanvasLayout, refs: Set<string>) {
    const current = this.get(projectId, refs);
    if (current.readOnly) throw rpcError("unsupported", "Future canvas layout version is read-only; file preserved");
    if (current.revision !== baseRevision) throw rpcError("stale_revision", "stale_revision: refresh the canvas before saving");
    const layout = CanvasLayoutSchema.parse(input);
    if (Object.keys(layout.positions).some(ref => !refs.has(ref))) throw rpcError("forbidden", "Layout refers to an entity outside this project or a removed entity");
    const groupIds = new Set(layout.groups.map(g => g.id));
    if (groupIds.size !== layout.groups.length || new Set(layout.stickies.map(s => s.id)).size !== layout.stickies.length || Object.values(layout.positions).some(p => p.group && !groupIds.has(p.group))) throw rpcError("protocol", "Invalid canvas group or sticky identifiers");
    const revision = current.revision + 1;
    const bytes = JSON.stringify({ v: 1, revision, layout });
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw rpcError("protocol", "Canvas layout exceeds 256 KiB");
    mkdirSync(this.home, { recursive: true }); writeFileDurable(this.path(projectId), bytes);
    return { revision };
  }
}
