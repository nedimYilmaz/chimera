import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import type { AgentRecord } from "@chimera/core/supervisor";
import { makeEngineHome } from "./helpers.js";

// F34 (plan §3.2): the STAMPING seam. A memory record's scope is resolved server-side from the
// writing agent's own project binding, and a search's default scope from the SEARCHING agent's —
// never from anything the caller passed. These tests exist to pin that a caller cannot write into
// or read out of a scope by asking for one.

// CORE-SUITE-BASELINE: spawns under this machine's concurrent-agent load can exceed vitest's
// 5000ms default; widened per existing precedent (engine-projects.test.ts).
vi.setConfig({ testTimeout: 60_000 });

// keeps an agent "running" (and therefore in supervisor.agents, un-archived) until killed
const RUNNING: FakeStep[] = [{ emit: { kind: "agent_started", data: {} } }, { awaitSend: true }, { end: { resultText: "x" } }];

function engineOn(home: string, scenarios: FakeStep[][] = []): Engine {
  return new Engine({ home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]) });
}

function makeDir(): string { return mkdtempSync(join(tmpdir(), "chimera-scopedir-")); }

type Rec = { id: string; scope: string | null; text: string };
type Hit = { record: Rec };

// A query-less search is newest-first, so assert on the SET of scopes, not their order —
// and normalize null so the default comparator doesn't stringify it to a trailing "null".
const scopesOf = (hits: Hit[]): string[] => hits.map((h) => h.record.scope ?? "(global)").sort();

/** A project plus one live agent bound to it — projectId is DERIVED from cwd by the spawn path
 *  (supervisor.ts projectFor), so the stamp is exercised end to end rather than injected. */
async function projectWithAgent(e: Engine, name: string): Promise<string> {
  const path = makeDir();
  await e.handle("project.create", { name, path, autoConductor: false });
  const rec = (await e.handle("agent.spawn", { spec: { prompt: "a", cwd: path, isolation: "none" } })) as AgentRecord;
  expect(rec.projectId).toBe(name);
  return rec.agentId;
}

describe("F34 memory scope — memory.add stamping", () => {
  it("stamps the author's own project onto the record", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const author = await projectWithAgent(e, "alpha");
    const rec = (await e.handle("memory.add", { author, text: "alpha retry budget is three" })) as Rec;
    expect(rec.scope).toBe("alpha");
  });

  it("is global (null) for a non-agent author, and does not throw", async () => {
    const e = engineOn(makeEngineHome());
    // "external" is what the memory_add tool sends when there is no ctx.agentId. projectIdOf must
    // be total: an unknown id is "no project", never an UnknownAgentError.
    const rec = (await e.handle("memory.add", { author: "external", text: "a lesson filed globally" })) as Rec;
    expect(rec.scope).toBeNull();
  });

  it("rejects a caller-supplied scope — the stamp cannot be forged", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const author = await projectWithAgent(e, "alpha");
    await expect(e.handle("memory.add", { author, text: "smuggled", scope: "beta" }))
      .rejects.toMatchObject({ code: "protocol" });
  });
});

describe("F34 memory scope — memory.search defaulting", () => {
  /** alpha note + beta note + global note, each with clearly distinct text so
   *  MEMORY-NO-DUPLICATES (which is scope-blind) never refuses the second add. */
  async function seeded(): Promise<{ e: Engine; alpha: string }> {
    const e = engineOn(makeEngineHome(), [RUNNING, RUNNING]);
    const alpha = await projectWithAgent(e, "alpha");
    const beta = await projectWithAgent(e, "beta");
    await e.handle("memory.add", { author: alpha, text: "alpha deploys through the blue ring" });
    await e.handle("memory.add", { author: beta, text: "beta pins its scheduler to one worker" });
    await e.handle("memory.add", { author: "external", text: "every service retries with jitter" });
    return { e, alpha };
  }

  it("defaults to the caller's project PLUS global — never the project alone", async () => {
    const { e, alpha } = await seeded();
    const hits = (await e.handle("memory.search", { agentId: alpha })) as Hit[];
    expect(scopesOf(hits)).toEqual(["(global)", "alpha"]);
  });

  it('scope:"*" is the documented escape back to every scope', async () => {
    const { e, alpha } = await seeded();
    const hits = (await e.handle("memory.search", { agentId: alpha, scope: "*" })) as Hit[];
    expect(scopesOf(hits)).toEqual(["(global)", "alpha", "beta"]);
  });

  it("a caller with no agentId (app, TUI, direct RPC) is never narrowed", async () => {
    const { e } = await seeded();
    const hits = (await e.handle("memory.search", {})) as Hit[];
    expect(scopesOf(hits)).toEqual(["(global)", "alpha", "beta"]);
  });

  it("agentId is caller identity, not an author filter", async () => {
    const { e, alpha } = await seeded();
    // If agentId leaked into MemorySearchFilters as `author` the global note would drop out.
    const hits = (await e.handle("memory.search", { agentId: alpha })) as Hit[];
    expect(hits.map((h) => h.record.text)).toContain("every service retries with jitter");
  });
});

describe("F34.FIX memory scope — default-narrowed empty search stays [] at the RPC layer", () => {
  it("0 project hits, 1 global/foreign hit ⇒ memory.search stays [] (no silent widen)", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING, RUNNING]);
    const alpha = await projectWithAgent(e, "alpha");
    const beta = await projectWithAgent(e, "beta");
    // Nothing in alpha's own scope and nothing global — only a beta-scoped record exists.
    // F34.QA-B used to silently re-run unnarrowed here and leak the beta hit through; F34.FIX
    // reverts that (qa/F34.md F34-3: the widening SIGNAL belongs at the MCP tool layer, the RPC's
    // declared success type — bare ScoredRecord[], consumed by app/tui/client too — must not
    // vary shape or leak cross-project records through the partition).
    await e.handle("memory.add", { author: beta, text: "beta pins its scheduler to one worker" });
    const hits = (await e.handle("memory.search", { agentId: alpha })) as Hit[];
    expect(hits).toEqual([]);
  });

  it('explicit scope:"beta" with 0 hits stays [] — the fallback must NOT fire', async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const alpha = await projectWithAgent(e, "alpha");
    await e.handle("memory.add", { author: alpha, text: "alpha deploys through the blue ring" });
    const hits = (await e.handle("memory.search", { agentId: alpha, scope: "beta" })) as Hit[];
    expect(hits).toEqual([]);
  });

  it("default scope with ≥1 project hit is unchanged — no widening triggered", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const alpha = await projectWithAgent(e, "alpha");
    // A beta hit exists too — if the fallback wrongly fired on a non-empty result it would leak in.
    await e.handle("memory.add", { author: alpha, text: "alpha deploys through the blue ring" });
    await e.handle("memory.add", { author: "external", text: "every service retries with jitter" });
    const hits = (await e.handle("memory.search", { agentId: alpha })) as Hit[];
    expect(scopesOf(hits)).toEqual(["(global)", "alpha"]);
  });
});

describe("F34 memory scope — stats", () => {
  it("memory.stats reports byScope, global first then alphabetical", async () => {
    const e = engineOn(makeEngineHome(), [RUNNING]);
    const alpha = await projectWithAgent(e, "alpha");
    await e.handle("memory.add", { author: alpha, text: "alpha deploys through the blue ring" });
    await e.handle("memory.add", { author: "external", text: "every service retries with jitter" });
    const stats = (await e.handle("memory.stats", {})) as { byScope: Array<{ scope: string | null; count: number }> };
    expect(stats.byScope).toEqual([{ scope: null, count: 1 }, { scope: "alpha", count: 1 }]);
  });
});
