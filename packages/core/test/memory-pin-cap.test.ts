import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, PinCapError } from "@chimera/core/memory";
import { MemoryAddParams } from "@chimera/protocol";

const MAX_PINS_PER_SCOPE = 50;   // memory.ts — module-private, mirrored like memory-scope.test.ts:8

// F36 §3.3. Pinning is a WEIGHT, not an exemption: W_PIN only outranks the largest unpinned score,
// so a store of nothing but pins still evicts and stays bounded. The per-scope cap is the second
// half of that guarantee — it stops one project from spending the whole budget on itself.
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "chimera-mem-pin-"));
  return { dir, mem: new MemoryStore(dir) };
}

// add() deliberately cannot set `pinned` (case 21), so every pin here goes through the edit path
// that the MCP surface actually exposes.
function fill(mem: MemoryStore, scope: string | undefined, n: number, tag: string): string[] {
  return Array.from({ length: n }, (_, i) =>
    mem.add({ author: "ag", text: `${tag} candidate ${i}`, scope }).id);
}

describe("MemoryStore pin cap (F36)", () => {
  it("case 17: the 51st pin in a scope is refused and names the cap", () => {
    const { mem } = rig();
    const ids = fill(mem, "alpha", MAX_PINS_PER_SCOPE + 1, "alpha");
    for (const id of ids.slice(0, MAX_PINS_PER_SCOPE)) expect(mem.edit(id, { pinned: true }).pinned).toBe(true);

    let err: unknown;
    try { mem.edit(ids[MAX_PINS_PER_SCOPE]!, { pinned: true }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PinCapError);
    expect((err as { code: string }).code).toBe("conflict");       // routed like DuplicateMemoryError
    expect((err as Error).message).toContain(String(MAX_PINS_PER_SCOPE));
    // The refusal is total: the record is unchanged, not silently half-pinned.
    expect(mem.get(ids[MAX_PINS_PER_SCOPE]!).record.pinned).toBe(false);
  });

  it("case 18: the cap is per scope", () => {
    const { mem } = rig();
    for (const id of fill(mem, "alpha", MAX_PINS_PER_SCOPE, "alpha")) mem.edit(id, { pinned: true });

    // A different project's budget is untouched by alpha having spent all of its own...
    const beta = mem.add({ author: "ag", text: "beta candidate one", scope: "beta" });
    expect(mem.edit(beta.id, { pinned: true }).pinned).toBe(true);
    // ...and so is the global (scope:null) budget, which is where most notes still live.
    const global = mem.add({ author: "ag", text: "global candidate one" });
    expect(mem.edit(global.id, { pinned: true }).pinned).toBe(true);
  });

  it("case 19: unpinning frees a slot; re-pinning an already-pinned record is not refused", () => {
    const { mem } = rig();
    const ids = fill(mem, "alpha", MAX_PINS_PER_SCOPE + 1, "alpha");
    for (const id of ids.slice(0, MAX_PINS_PER_SCOPE)) mem.edit(id, { pinned: true });

    // The cap is checked on the TRANSITION into pinned, so a no-op re-pin can never be the write
    // that trips it — otherwise any idempotent retry would start failing at exactly 50.
    expect(mem.edit(ids[0]!, { pinned: true }).pinned).toBe(true);
    expect(() => mem.edit(ids[MAX_PINS_PER_SCOPE]!, { pinned: true })).toThrow(PinCapError);

    expect(mem.edit(ids[0]!, { pinned: false }).pinned).toBe(false);
    expect(mem.edit(ids[MAX_PINS_PER_SCOPE]!, { pinned: true }).pinned).toBe(true);
  });

  it("case 20: edit preserves pinned when the patch omits it", () => {
    const { mem } = rig();
    const r = mem.add({ author: "ag", text: "pinned candidate one", scope: "alpha" });
    mem.edit(r.id, { pinned: true });
    const edited = mem.edit(r.id, { text: "pinned candidate one, revised" }, "editor-1");
    expect(edited.pinned).toBe(true);
    expect(edited.author).toBe("editor-1");
    expect(mem.edit(r.id, { tags: ["x"] }).pinned).toBe(true);
  });

  it("case 21: MemoryAddParams rejects pinned", () => {
    // A note is pinned once it has PROVED durable — that is an edit, not a birth property. Keeping
    // it out of memory_add also keeps the core-tier tool's eager payload (billed on every spawn) flat.
    expect(MemoryAddParams.safeParse({ author: "a", text: "t", pinned: true }).success).toBe(false);
    expect(MemoryAddParams.safeParse({ author: "a", text: "t" }).success).toBe(true);
  });
});
