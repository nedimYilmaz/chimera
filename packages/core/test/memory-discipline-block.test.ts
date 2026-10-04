import { describe, it, expect } from "vitest";
import { buildMemoryDisciplineBlock, CAPABILITY_BLOCK_TOOLS } from "@chimera/core/supervisor";
import { ENGINE_TOOL_NAMES } from "@chimera/protocol/engine-help";

// MEMORY-DISCIPLINE: the standing rule every memory-capable agent is given. The mechanical half
// (no duplicates) lives in MemoryStore.add; this block is what makes the refusal legible and
// what tells an agent to look before it guesses. Pinned so a reword is a visible diff.

describe("memory discipline block", () => {
  const block = buildMemoryDisciplineBlock();

  it("names only tools that actually exist — a block naming a phantom tool teaches a dead end", () => {
    for (const name of Object.values(CAPABILITY_BLOCK_TOOLS)) {
      expect(ENGINE_TOOL_NAMES).toContain(name);
    }
    for (const t of ["memory_search", "memory_add", "memory_edit", "memory_get"]) {
      expect(block).toContain(t);
    }
  });

  it("establishes all three rules: look first, write back without duplicating, never invent", () => {
    expect(block).toMatch(/memory_search it BEFORE the web or a guess/);
    // and explicitly NOT a startup ritual — an unconditional session-start search would make
    // every agent pay for a lookup most of them never needed
    expect(block).toMatch(/No need to search at startup/);
    expect(block).toMatch(/memory_edit that record instead/);
    expect(block).toMatch(/Never state as fact/);
  });

  it("stays short enough to actually be read — this fleet's own token-economy rule applies to it", () => {
    expect(block.length).toBeLessThanOrEqual(1_400);
  });
});
