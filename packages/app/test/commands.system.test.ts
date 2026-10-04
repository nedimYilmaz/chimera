// W6 unit gates — pure logic in state/commands.system.ts: the fuzzy palette
// scorer, replay paging + turn stepping, spend thresholds, cooling countdown
// math, and the mcp param builders.
import { describe, expect, it } from "vitest";
import { ENGINE_TOOL_NAMES } from "@chimera/mcp/engine-help";
import { HistoryRunsRequestSchema } from "@chimera/protocol";
import {
  buildFlatParams,
  buildPaletteCatalog,
  coolingLong,
  coolingMSS,
  filterPaletteEntries,
  filterTools,
  fuzzyScore,
  MCP_INVOKE_RPCS,
  MCP_TOOLS,
  nextReplayPage,
  olderPageRequest,
  spendTone,
  stepTurn,
  turnCount,
  turnStarts,
  turnWindow,
} from "../src/state/commands.system";

describe("fuzzyScore", () => {
  it("matches subsequences only", () => {
    expect(fuzzyScore("kil", "/kill")).not.toBeNull();
    expect(fuzzyScore("klx", "/kill")).toBeNull();
  });
  it("empty query matches everything at score 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
  it("prefers consecutive + word-start matches over scattered ones", () => {
    const tight = fuzzyScore("kill", "/kill")!;
    const scattered = fuzzyScore("kill", "k i l l task")!;
    expect(tight).toBeGreaterThan(scattered);
  });
  it("is case-insensitive", () => {
    expect(fuzzyScore("KILL", "/kill")).toEqual(fuzzyScore("kill", "/kill"));
  });
});

describe("palette catalog + ranking", () => {
  const rows = [
    { chord: "ctrl+k", action: "agents.kill", scope: "agents", label: "kill" },
    { chord: "ctrl+o", action: "agents.spawn", scope: "agents", label: "spawn" },
    { chord: "up", action: "agents.up", scope: "agents", label: "select" },
    { chord: "2", action: "tab.projects", scope: "global", label: "projects", unbound: true },
    { chord: "x", action: "agents.kill", scope: "agents", label: "kill dup" }, // dup action
  ];
  const builtins = [{ name: "kill", description: "kill the selected agent", keyHint: "ctrl+k" }];

  it("skips unbound rows and dedupes by action id", () => {
    const cat = buildPaletteCatalog(rows, builtins);
    expect(cat.find((e) => e.id === "tab.projects")).toBeUndefined();
    expect(cat.filter((e) => e.id === "agents.kill")).toHaveLength(1);
    expect(cat.find((e) => e.id === "agents.kill")?.keyHint).toBe("ctrl+k"); // first chord wins
  });
  it("ranks name matches above description matches", () => {
    const cat = buildPaletteCatalog(rows, builtins);
    const ranked = filterPaletteEntries(cat, "kill");
    // "/kill" (name hit) must beat "agents.up" (no hit → dropped) and any
    // description-only hit; the name-hit builtin sits above the action whose
    // NAME also matches but longer.
    expect(ranked[0]!.name).toBe("/kill");
    expect(ranked.some((e) => e.id === "agents.up")).toBe(false);
  });
  it("empty query returns the whole catalog in order", () => {
    const cat = buildPaletteCatalog(rows, builtins);
    expect(filterPaletteEntries(cat, "")).toEqual(cat);
  });
});

describe("spendTone thresholds (B1: green→warn@70%→danger@90%)", () => {
  it("maps the documented bands", () => {
    expect(spendTone(0, 10)).toBe("success");
    expect(spendTone(6.99, 10)).toBe("success");
    expect(spendTone(7, 10)).toBe("warn");
    expect(spendTone(8.99, 10)).toBe("warn");
    expect(spendTone(9, 10)).toBe("danger");
    expect(spendTone(15, 10)).toBe("danger");
  });
  it("degrades safely without a cap", () => {
    expect(spendTone(5, 0)).toBe("success");
    expect(spendTone(5, Number.NaN)).toBe("success");
  });
});

describe("cooling countdown math", () => {
  const now = 1_000_000;
  it("formats the card's long form (mock '3m 12s')", () => {
    expect(coolingLong(now + 192_000, now)).toBe("3m 12s");
    expect(coolingLong(now + 12_000, now)).toBe("12s");
  });
  it("formats the chip's m:ss form, zero-padded", () => {
    expect(coolingMSS(now + 192_000, now)).toBe("3:12");
    expect(coolingMSS(now + 5_000, now)).toBe("0:05");
  });
  it("clamps a past deadline to zero", () => {
    expect(coolingLong(now - 1, now)).toBe("0s");
    expect(coolingMSS(now - 1, now)).toBe("0:00");
  });
});

describe("replay paging", () => {
  it("a FULL batch pages forward from last seq + 1", () => {
    const batch = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1 }));
    expect(nextReplayPage(batch, 500)).toBe(501);
  });
  it("a short batch ends the loop", () => {
    expect(nextReplayPage([{ seq: 7 }], 500)).toBeNull();
    expect(nextReplayPage([], 500)).toBeNull();
  });
});

describe("olderPageRequest (F05 EventsScreen backward paging)", () => {
  it("requests the window ending just before the oldest in view", () => {
    expect(olderPageRequest(1000, 500)).toEqual({ fromSeq: 500, limit: 500 });
  });
  it("clamps fromSeq to 1 (never below the first seq)", () => {
    expect(olderPageRequest(300, 500)).toEqual({ fromSeq: 1, limit: 500 });
  });
  it("returns null when nothing older can exist (oldest ≤ 1)", () => {
    expect(olderPageRequest(1, 500)).toBeNull();
    expect(olderPageRequest(0, 500)).toBeNull();
  });
});

describe("replay turn stepping (result/turn_complete boundaries)", () => {
  const ev = (kind: string) => ({ kind });
  const log = [
    ev("agent_started"), ev("message_delta"), ev("turn_complete"), // turn 0
    ev("message_delta"), ev("result"),                             // turn 1
    ev("agent_started"), ev("message_delta"),                      // turn 2 (open)
  ];
  it("splits turns at boundaries, trailing boundary opens no empty turn", () => {
    expect(turnStarts(log)).toEqual([0, 3, 5]);
    expect(turnCount(log)).toBe(3);
    const closed = [ev("agent_started"), ev("result")];
    expect(turnStarts(closed)).toEqual([0]);
  });
  it("steps with clamping", () => {
    expect(stepTurn(log, 0, 1)).toBe(1);
    expect(stepTurn(log, 2, 1)).toBe(2);
    expect(stepTurn(log, 0, -1)).toBe(0);
    expect(stepTurn([], 0, 1)).toBe(0);
  });
  it("windows each turn's inclusive event range", () => {
    expect(turnWindow(log, 0)).toEqual({ start: 0, end: 2 });
    expect(turnWindow(log, 1)).toEqual({ start: 3, end: 4 });
    expect(turnWindow(log, 2)).toEqual({ start: 5, end: 6 });
    expect(turnWindow([], 0)).toEqual({ start: 0, end: -1 });
  });
  it("an empty log has zero turns", () => {
    expect(turnCount([])).toBe(0);
  });
});

describe("mcp tool catalog", () => {
  it("is GENERATED from engine_help — exactly the engine's tools, no phantom, no gap (F07 drift guard)", () => {
    // The catalog is mapped over the shared ENGINE_TOOL_NAMES (@chimera/mcp), so it
    // must be EXACTLY that set, in that order — a tool added to the engine with no
    // presentation entry fails to compile; a phantom entry can't exist. This is the
    // "generated, not hand-written" enforcement: future drift FAILS the suite.
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([...ENGINE_TOOL_NAMES]);
    // the memory trio the palette used to be MISSING (the F07 audit FAIL) now shows.
    for (const t of ["memory_add", "memory_edit", "memory_search"]) {
      expect(MCP_TOOLS.map((x) => x.name)).toContain(t);
    }
  });
  // F50 BUDGET-RESUME criterion 15, as executable code: budget.resume is operator-only BY
  // CONSTRUCTION — chimera_call dispatches nothing outside MCP_TOOLS, so absence from this table
  // is a stronger guarantee than any runtime principal check. If someone ever adds a budget tool
  // here, that decision must be deliberate enough to delete this test.
  it("exposes no budget tool on the MCP surface (operator-only by absence)", () => {
    expect(ENGINE_TOOL_NAMES.filter((n) => n.includes("budget"))).toEqual([]);
    expect(MCP_TOOLS.filter((t) => t.rpc?.startsWith("budget."))).toEqual([]);
  });
  it("every invocable tool's rpc is allowlisted", () => {
    for (const t of MCP_TOOLS) {
      if (t.rpc) expect(MCP_INVOKE_RPCS.has(t.rpc)).toBe(true);
    }
    expect(MCP_INVOKE_RPCS.has("daemon.stop")).toBe(false);
  });
  // Mirrors the TUI's guard (tui/test/mcp-tools.test.ts): each raw tool hands the
  // user a hand-written SEED JSON skeleton, so a typo there ships a palette entry
  // that is dead-on-arrival (immediate "invalid JSON"). Nothing else on the app
  // side parses these strings.
  it("every raw tool seeds a valid JSON-object template", () => {
    const raw = MCP_TOOLS.filter((t) => t.kind === "raw");
    expect(raw.length).toBeGreaterThan(0);
    for (const t of raw) {
      const parsed = JSON.parse(t.rawTemplate!); // throws (failing the test, naming t.name) on a typo
      expect(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)).toBe(true);
    }
  });
  it("buildFlatParams validates + coerces", () => {
    expect(buildFlatParams([{ key: "agentId", label: "agentId", type: "string", required: true }], {}))
      .toEqual({ error: "agentId is required" });
    expect(buildFlatParams(
      [{ key: "n", label: "n", type: "number", integer: true }],
      { n: "5" },
    )).toEqual({ params: { n: 5 } });
    expect(buildFlatParams(
      [{ key: "allow", label: "allow", type: "boolean", required: true }],
      { allow: "yes" },
    )).toEqual({ params: { allow: true } });
  });
  it("filterTools is a substring browse filter", () => {
    expect(filterTools(MCP_TOOLS, "team").every((t) => `${t.name} ${t.description}`.toLowerCase().includes("team"))).toBe(true);
    expect(filterTools(MCP_TOOLS, "").length).toBe(MCP_TOOLS.length);
  });
});

// F25.QA: mirrors the TUI palette gate — severity is an enum in the daemon's schema, so a typo
// must fail in the form rather than travel to the daemon as a raw zod error.
describe("review_finding_add severity is a validated enum (F25.QA)", () => {
  const tool = MCP_TOOLS.find((t) => t.name === "review_finding_add")!;
  it("rejects a severity outside note/warning/blocking", () => {
    expect(buildFlatParams(tool.fields ?? [], { taskId: "t1", path: "a.ts", severity: "bogus", body: "b" }).error)
      .toMatch(/severity must be one of: note, warning, blocking/);
  });
  it("accepts each of the three severities", () => {
    for (const severity of ["note", "warning", "blocking"]) {
      expect(buildFlatParams(tool.fields ?? [], { taskId: "t1", path: "a.ts", severity, body: "b" }))
        .toEqual({ params: { taskId: "t1", path: "a.ts", severity, body: "b" } });
    }
  });
});

// [F13.QA] Guard carried over from the retired TUI's mcp-tools test: a flat field's `key` is the
// WIRE param name (buildFlatParams writes params[f.key] verbatim) and history.runs' request
// schema is .strict(), so a mislabelled key makes the palette control fail outright.
describe("history_runs palette params match the RPC request schema", () => {
  it("builds params HistoryRunsRequestSchema accepts, with every field filled", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "history_runs")!;
    expect(tool).toBeDefined();
    const values: Record<string, string> = {};
    for (const f of tool.fields ?? []) {
      // limit is capped at 500 by the schema; from/to are epoch ms.
      values[f.key] = f.type === "number" ? (f.key === "limit" ? "100" : "1700000000000") : f.type === "boolean" ? "true" : "x";
    }
    const built = buildFlatParams(tool.fields ?? [], values);
    expect(built.error).toBeUndefined();
    const parsed = HistoryRunsRequestSchema.safeParse(built.params);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });
});
