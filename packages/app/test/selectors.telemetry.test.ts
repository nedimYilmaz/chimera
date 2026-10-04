import { describe, expect, it } from "vitest";
import type { AgentView, UiState } from "@chimera/ui-state";
import { bashCommandName, fleetTelemetry, pushSample, rates, sparkPath, usageTotal, SERIES_CAPACITY } from "../src/state/selectors.telemetry";

// FLEET-TELEMETRY: the dashboard's arithmetic, tested without a DOM. The panel is a renderer;
// every number it shows is decided here.

const agent = (over: Partial<AgentView> = {}): AgentView => ({
  agentId: over.agentId ?? "a1", state: "running", busy: false, shadow: false,
  costUsd: 0, usage: null, model: "claude-sonnet-5", effort: undefined,
  transcript: [], tools: [], lastEventTs: 0, pendingQuestion: null, pendingDialog: null,
  resultDetail: null, conductor: false, session: false, historyLoaded: false,
  ...over,
} as AgentView);

const stateWith = (agents: AgentView[], queues: unknown[] = []): UiState => ({
  agents: Object.fromEntries(agents.map((a) => [a.agentId, a])),
  queues: { available: true, items: queues },
} as unknown as UiState);

describe("fleetTelemetry", () => {
  it("busyRatio is the headline: what share of the OPEN fleet is actually working", () => {
    const t = fleetTelemetry(stateWith([
      agent({ agentId: "a", busy: true }),
      agent({ agentId: "b", busy: false }),
      agent({ agentId: "c", busy: false, state: "paused" }),
      agent({ agentId: "d", state: "done" }),      // terminal — history, not fleet
    ]));
    expect(t.live).toBe(3);
    expect(t.busy).toBe(1);
    expect(t.paused).toBe(1);
    expect(t.busyRatio).toBeCloseTo(1 / 3);
  });

  it("an empty fleet reports 0, never NaN — a 0/0 ratio is where a dashboard loses trust", () => {
    const t = fleetTelemetry(stateWith([]));
    expect(t.busyRatio).toBe(0);
    expect(Number.isNaN(t.busyRatio)).toBe(false);
  });

  it("context occupancy EXCLUDES output — it is what fills the window going in, not what was billed", () => {
    const u = { input: 1000, output: 500, cacheRead: 200, cacheCreation: 100 };
    const t = fleetTelemetry(stateWith([agent({ usage: u, ctxUsage: u, model: "claude-sonnet-5" })]));
    expect(usageTotal(u)).toBe(1800);          // billable total, output included
    expect(t.ctxUsed).toBe(1300);              // 1000 + 200 + 100 — the ctx basis
    expect(t.tokens).toBe(1800);               // spend is still the full billable figure
  });

  it("buckets by model and by effort, biggest consumer first", () => {
    const t = fleetTelemetry(stateWith([
      agent({ agentId: "a", model: "opus", effort: "high", usage: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0 } }),
      agent({ agentId: "b", model: "sonnet", effort: "high", usage: { input: 100, output: 0, cacheRead: 0, cacheCreation: 0 } }),
      agent({ agentId: "c", model: "sonnet", usage: { input: 50, output: 0, cacheRead: 0, cacheCreation: 0 } }),
    ]));
    expect(t.byModel[0]!.key).toBe("sonnet");
    expect(t.byModel[0]!.agents).toBe(2);
    expect(t.byModel[0]!.tokens).toBe(150);
    // an agent that never set one is on the provider's default, not on an invented level
    expect(t.byEffort.map((b) => b.key).sort()).toEqual(["default", "high"]);
  });

  it("topCost ranks live agents by spend and caps the list", () => {
    const many = Array.from({ length: 9 }, (_, i) => agent({ agentId: `a${i}`, costUsd: i }));
    const t = fleetTelemetry(stateWith(many));
    expect(t.topCost).toHaveLength(5);
    expect(t.topCost[0]!.costUsd).toBe(8);
    expect(t.topCost[0]!.agentId).toBe("a8");
  });

  it("counts queued work as pending + blocked across every queue", () => {
    const t = fleetTelemetry(stateWith([], [
      { counts: { pending: 3, blocked: 2, in_progress: 9 } },
      { counts: { pending: 1 } },
    ]));
    expect(t.queued).toBe(6);
  });
});

describe("rolling series", () => {
  it("never grows past its capacity — the panel animates minutes, not the window's lifetime", () => {
    let s: ReturnType<typeof pushSample> = [];
    for (let i = 0; i < SERIES_CAPACITY + 40; i++) s = pushSample(s, { t: i, tokens: i, costUsd: 0, busy: 0, live: 0 });
    expect(s).toHaveLength(SERIES_CAPACITY);
    expect(s[s.length - 1]!.t).toBe(SERIES_CAPACITY + 39);   // newest kept
  });

  it("turns cumulative totals into per-second rates", () => {
    const r = rates([
      { t: 0, tokens: 0, costUsd: 0, busy: 0, live: 1 },
      { t: 1000, tokens: 500, costUsd: 0.5, busy: 1, live: 1 },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.tokensPerSec).toBe(500);
    expect(r[0]!.costPerSec).toBeCloseTo(0.5);
  });

  it("a TOTAL that drops (a purge, an agent going terminal) reads as 0, not a negative spike", () => {
    const r = rates([
      { t: 0, tokens: 900, costUsd: 5, busy: 0, live: 2 },
      { t: 1000, tokens: 100, costUsd: 1, busy: 0, live: 1 },
    ]);
    expect(r[0]!.tokensPerSec).toBe(0);
    expect(r[0]!.costPerSec).toBe(0);
  });
});

describe("sparkPath", () => {
  it("is empty for no data rather than a malformed path", () => {
    expect(sparkPath([], 100, 20)).toBe("");
  });

  it("draws a flat line for a flat series instead of dividing by a zero range", () => {
    const d = sparkPath([5, 5, 5], 100, 20);
    expect(d).toContain("M0.00,");
    expect(d.includes("NaN")).toBe(false);
  });

  it("puts the highest value at the top of the box and the lowest at the bottom", () => {
    const d = sparkPath([0, 10], 100, 20);
    expect(d).toBe("M0.00,20.00 L100.00,0.00");
  });
});

// CTX-VS-BILLABLE: the bug this split exists for — a cumulative `result` usage folded into the
// same field the ctx meter read, so the meter climbed past the model's own window (observed
// live: 471k against a 200k limit) and then sat pinned at 100% forever.
describe("context basis vs billable tally", () => {
  it("prefers the dedicated ctx baseline over the (possibly cumulative) billable tally", () => {
    const t = fleetTelemetry(stateWith([agent({
      model: "claude-sonnet-5",
      usage: { input: 460_000, output: 9_000, cacheRead: 8_000, cacheCreation: 3_000 },  // cumulative
      ctxUsage: { input: 30_000, output: 2_000, cacheRead: 5_000, cacheCreation: 1_000 }, // this turn
    })]));
    expect(t.ctxUsed).toBe(36_000);          // 30k + 5k + 1k — the real occupancy
    expect(t.tokens).toBe(480_000);          // spend still counts everything billed
  });

  it("keeps occupancy unknown when no ctx baseline has arrived yet", () => {
    const t = fleetTelemetry(stateWith([agent({
      model: "claude-sonnet-5",
      usage: { input: 100, output: 50, cacheRead: 10, cacheCreation: 5 },
    })]));
    expect(t.ctxUsed).toBe(0);
    expect(t.ctxLimit).toBe(0);
    expect(t.ctxPressure[0]).toMatchObject({ known: false, pct: 0, used: 0 });
  });

  it("never reports occupancy above the window", () => {
    const t = fleetTelemetry(stateWith([agent({
      model: "claude-sonnet-5",
      ctxUsage: { input: 9_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
    })]));
    expect(t.ctxPressure[0]!.pct).toBeLessThanOrEqual(100);
  });
});

// TOOL-METRICS: what the fleet is actually doing, and which MCP servers are earning their keep.
// An MCP tool is identifiable by its own name (mcp__<server>__<tool>), so the split needs no
// extra plumbing — but it does need to be right, since a mis-parse silently empties a panel.
describe("tool and MCP metrics", () => {
  const withTools = (names: string[]) =>
    agent({ tools: names.map((toolName, i) => ({ ts: i, toolName, status: "done" as const })) });

  it("counts CALLS, and how many agents used each tool", () => {
    const t = fleetTelemetry(stateWith([
      { ...withTools(["Bash", "Bash", "Read"]), agentId: "a" } as never,
      { ...withTools(["Bash"]), agentId: "b" } as never,
    ]));
    expect(t.toolCalls).toBe(4);
    expect(t.tools[0]).toMatchObject({ key: "Bash", tokens: 3, agents: 2 });
    expect(t.tools[1]).toMatchObject({ key: "Read", tokens: 1, agents: 1 });
  });

  it("splits MCP calls out by SERVER from the mcp__<server>__<tool> name", () => {
    const t = fleetTelemetry(stateWith([
      { ...withTools(["mcp__chimera__memory_add", "mcp__chimera__agent_spawn", "mcp__slack__post", "Bash"]), agentId: "a" } as never,
    ]));
    expect(t.mcpCalls).toBe(3);
    expect(t.mcpServers.map((b) => b.key)).toEqual(["chimera", "slack"]);
    expect(t.mcpServers[0]!.tokens).toBe(2);
    // the native tool is counted in `tools` but never as an MCP server
    expect(t.tools.some((b) => b.key === "Bash")).toBe(true);
  });

  it("handles a server name containing underscores", () => {
    const t = fleetTelemetry(stateWith([{ ...withTools(["mcp__my_server__do_thing"]), agentId: "a" } as never]));
    expect(t.mcpServers[0]!.key).toBe("my_server");
  });

  it("is empty, not broken, for a fleet that has called nothing", () => {
    const t = fleetTelemetry(stateWith([agent({})]));
    expect(t.tools).toEqual([]);
    expect(t.mcpServers).toEqual([]);
    expect(t.toolCalls).toBe(0);
  });
});

// CTX-LIMIT-DISPROVEN-BY-EVIDENCE: `effectiveContextLimit` is an ASSUMPTION frozen on the record
// at spawn; the reported context is a MEASUREMENT. When the measurement exceeds the assumption,
// the assumption is wrong — and pinning the meter at "100% · 210k/200k" hid exactly that, in a
// way indistinguishable from a genuinely full context.
describe("the context denominator remains independent from usage", () => {
  it("keeps the daemon's effective limit when usage exceeds it", () => {
    const t = fleetTelemetry(stateWith([agent({
      model: "claude-opus-5",
      effectiveContextLimit: 200_000,                                    // stamped before the catalog knew better
      ctxUsage: { input: 200_000, output: 0, cacheRead: 10_000, cacheCreation: 0 },
    })]));
    expect(t.ctxLimit).toBe(200_000);
    expect(t.ctxPressure[0]!.pct).toBe(100);
  });

  it("leaves a consistent limit alone — it can only ever move UP", () => {
    const t = fleetTelemetry(stateWith([agent({
      model: "claude-opus-4-8",
      effectiveContextLimit: 200_000,
      ctxUsage: { input: 50_000, output: 0, cacheRead: 0, cacheCreation: 0 },
    })]));
    expect(t.ctxLimit).toBe(200_000);
  });

  it("an operator's own lower compaction threshold is still honoured until the evidence breaks it", () => {
    const t = fleetTelemetry(stateWith([agent({
      model: "claude-opus-5",
      effectiveContextLimit: 80_000,                                     // deliberately configured
      ctxUsage: { input: 40_000, output: 0, cacheRead: 0, cacheCreation: 0 },
    })]));
    expect(t.ctxLimit).toBe(80_000);
  });

  it("does not turn a cumulative-looking numerator into the denominator", () => {
    const t = fleetTelemetry(stateWith([agent({
      model: "claude-opus-5",
      effectiveContextLimit: 922_000,
      ctxUsage: { input: 9_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
    })]));
    expect(t.ctxLimit).toBe(922_000);
    expect(t.ctxPressure[0]!.pct).toBe(100);
  });
});

// TOOL-METRICS-BASH-BREAKDOWN: "Bash ×140" reports the shell, not the work. The leading
// executable is what distinguishes an agent reading code from one touching cloud infrastructure,
// and reaching it means stepping over the noise agents habitually put in front of it.
describe("bashCommandName", () => {
  it("names the plain command", () => {
    expect(bashCommandName("git status --short")).toBe("git");
    expect(bashCommandName("  grep -rn foo src/  ")).toBe("grep");
  });

  it("steps over a cd prefix — the navigation is not the work", () => {
    expect(bashCommandName("cd /Users/x/repo && aws s3 ls")).toBe("aws");
    expect(bashCommandName('cd "/path with spaces" && gcloud compute instances list')).toBe("gcloud");
    expect(bashCommandName("cd /a && cd /b && kubectl get pods")).toBe("kubectl");
  });

  it("steps over env assignments, env -u, and sudo", () => {
    expect(bashCommandName("FOO=bar BAZ=1 terraform plan")).toBe("terraform");
    expect(bashCommandName("env -u CHIMERA_AGENT_ID -u CHIMERA_TEAM npx vitest run")).toBe("npx");
    expect(bashCommandName("sudo systemctl restart nginx")).toBe("systemctl");
  });

  it("uses the basename of an absolute path", () => {
    expect(bashCommandName("/usr/local/bin/gcloud auth list")).toBe("gcloud");
  });

  it("attributes a pipeline to its first command", () => {
    expect(bashCommandName("aws ec2 describe-instances | jq '.Reservations'")).toBe("aws");
  });

  it("returns null rather than inventing a name for something unparseable", () => {
    expect(bashCommandName("")).toBeNull();
    expect(bashCommandName("   ")).toBeNull();
    expect(bashCommandName("(echo hi)")).toBeNull();
  });
});

describe("tool buckets are readable", () => {
  const call = (toolName: string, input?: unknown) => ({ ts: 0, toolName, status: "done" as const, ...(input ? { input } : {}) });

  it("splits Bash by the CLI it ran, so the panel shows work instead of the shell", () => {
    const t = fleetTelemetry(stateWith([{
      ...agent({ agentId: "a" }),
      tools: [
        call("Bash", { command: "git log --oneline" }),
        call("Bash", { command: "cd /repo && git status" }),
        call("Bash", { command: "aws s3 ls" }),
      ],
    } as never]));
    expect(t.tools.map((b) => b.key)).toEqual(["Bash · git", "Bash · aws"]);
    expect(t.tools[0]!.tokens).toBe(2);
    expect(t.toolCalls).toBe(3);              // the total still counts every call
  });

  it("falls back to plain Bash when there is no command to attribute it to", () => {
    const t = fleetTelemetry(stateWith([{ ...agent({ agentId: "a" }), tools: [call("Bash")] } as never]));
    expect(t.tools[0]!.key).toBe("Bash");
  });

  it("renders an MCP tool as server · tool — the raw names truncated to identical-looking rows", () => {
    const t = fleetTelemetry(stateWith([{
      ...agent({ agentId: "a" }),
      tools: [call("mcp__plugin_atlassian__getJiraIssue"), call("mcp__chimera__memory_add")],
    } as never]));
    expect(t.tools.map((b) => b.key).sort()).toEqual(["chimera · memory_add", "plugin_atlassian · getJiraIssue"]);
    // the MCP-server split is unaffected by the relabelling
    expect(t.mcpServers.map((b) => b.key).sort()).toEqual(["chimera", "plugin_atlassian"]);
  });
});

// "default" is a real bucket — chimera set no effort on the spawn, so the provider chose. The
// question it raises ("default meaning what?") has an answer, and the panel is where it belongs.
describe("the default-effort bucket", () => {
  it("is keyed 'default' for an agent that never set one, not an invented level", () => {
    const t = fleetTelemetry(stateWith([agent({ agentId: "a" })]));
    expect(t.byEffort.map((b) => b.key)).toEqual(["default"]);
  });

  it("keeps an explicit level as itself", () => {
    const t = fleetTelemetry(stateWith([
      agent({ agentId: "a", effort: "low" }),
      agent({ agentId: "b" }),
    ]));
    expect(t.byEffort.map((b) => b.key).sort()).toEqual(["default", "low"]);
  });
});
