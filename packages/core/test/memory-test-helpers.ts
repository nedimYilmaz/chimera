import type { MemoryStore } from "../src/memory.js";

// Exercise the archive/chain-repair batch primitive directly. Capacity reductions now retain
// existing notes, so bulk eviction is intentionally unreachable through edit/config APIs.
export function pruneOverflowForTest(store: MemoryStore): void {
  store["save"](true);
}
