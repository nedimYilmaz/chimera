import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@chimera/protocol";
import {
  a2aFeed,
  a2aRole,
  activeA2APairs,
  agentSkillRows,
  buildCreateParams,
  buildImportParams,
  catalogRows,
  conductorAccountPin,
  filterProjects,
  fmtAgo,
  isBlankProjectForm,
  latestSessionSeq,
  projectCommandEntries,
  projectRow,
  projectStatus,
  sessionRow,
  unseenTotal,
  validateImportForm,
  A2A_FEED_MAX,
} from "../src/state/selectors.projects";

// W7 gate (app unit tests): the pure projects/a2a/plugins selectors — the a2a
// derivation windows + decay, the badge total, the project/session row
// projections and the import-form builders.

let seq = 0;
const ev = (agentId: string, kind: NormalizedEvent["kind"], data: Record<string, unknown> = {}, ts?: number): NormalizedEvent =>
  ({ ts: ts ?? 1000 + ++seq, seq: ++seq, agentId, kind, data });

describe("a2aFeed derivation", () => {
  it("derives a send exchange from a delivered status carrying an agent `from`", () => {
    const feed = a2aFeed([ev("frosty", "status", { delivered: true, from: "eager", text: "rowscroll patch'ini review et" })]);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ from: "eager", to: "frosty", kind: "send", text: "rowscroll patch'ini review et" });
  });

  it("skips non-agent senders: tui, app, assign, ask (the ask delivery is covered by agent_question)", () => {
    const feed = a2aFeed([
      ev("a", "status", { delivered: true, from: "tui", text: "human" }),
      ev("a", "status", { delivered: true, from: "app", text: "human (app cockpit)" }),
      ev("a", "status", { delivered: true, from: "assign", text: "scheduler" }),
      ev("a", "status", { delivered: true, from: "ask", text: "[question q1 from b] ..." }),
    ]);
    expect(feed).toEqual([]);
  });

  it("derives a question exchange from agent_question{to} (event agentId IS the asker)", () => {
    const feed = a2aFeed([ev("asker", "agent_question", { questionId: "q1", prompt: "review ok?", to: "target" })]);
    expect(feed[0]).toMatchObject({ from: "asker", to: "target", kind: "question", text: "review ok?" });
  });

  it("derives an answer exchange from the target's answer_question tool_call, resolved via the qid map", () => {
    const feed = a2aFeed([
      ev("asker", "agent_question", { questionId: "q1", prompt: "review ok?", to: "target" }),
      ev("target", "tool_call", { toolName: "mcp__chimera__answer_question", input: { questionId: "q1", text: "review tamam" } }),
    ]);
    expect(feed[0]).toMatchObject({ from: "target", to: "asker", kind: "answer", text: "review tamam" });
    expect(feed[1]!.kind).toBe("question");
  });

  it("an unmatched questionId (ask_human) yields no answer exchange", () => {
    const feed = a2aFeed([
      ev("target", "tool_call", { toolName: "answer_question", input: { questionId: "ghost", text: "x" } }),
    ]);
    expect(feed).toEqual([]);
  });

  it("keeps a latest-N ring, newest first", () => {
    const events = Array.from({ length: A2A_FEED_MAX + 3 }, (_, i) =>
      ev("rcv", "status", { delivered: true, from: "snd", text: `m${i}` }));
    const feed = a2aFeed(events);
    expect(feed).toHaveLength(A2A_FEED_MAX);
    expect(feed[0]!.text).toBe(`m${A2A_FEED_MAX + 2}`);      // newest first
    expect(feed[feed.length - 1]!.text).toBe("m3");           // oldest kept
  });
});

describe("a2a pulse window + decay", () => {
  const at = (ts: number) => a2aFeed([ev("rcv", "status", { delivered: true, from: "snd", text: "hi" }, ts)]);

  it("a pair is active within the ~3s window and decays after it", () => {
    const feed = at(10_000);
    expect(activeA2APairs(feed, 10_500)).toHaveLength(1);
    expect(activeA2APairs(feed, 13_000)).toHaveLength(1);    // boundary inclusive
    expect(activeA2APairs(feed, 13_001)).toHaveLength(0);    // one-shot decay
  });

  it("a2aRole: sender wins over receiver; uninvolved agents get null", () => {
    const feed = a2aFeed([
      ev("b", "status", { delivered: true, from: "a", text: "1" }, 10_000),
      ev("a", "status", { delivered: true, from: "b", text: "2" }, 10_100),
    ]);
    const active = activeA2APairs(feed, 10_200);
    expect(a2aRole(active, "a")).toBe("sender");
    expect(a2aRole(active, "b")).toBe("sender");             // b sent too (2nd exchange)
    expect(a2aRole(active, "c")).toBe(null);
    const oneWay = activeA2APairs(a2aFeed([ev("b", "status", { delivered: true, from: "a", text: "1" }, 10_000)]), 10_200);
    expect(a2aRole(oneWay, "b")).toBe("receiver");
  });

  it("fmtAgo renders s/m buckets", () => {
    expect(fmtAgo(10_000, 12_000)).toBe("2s");
    expect(fmtAgo(10_000, 51_000)).toBe("41s");
    expect(fmtAgo(0, 180_000)).toBe("3m");
  });
});

describe("badge total + project rows", () => {
  it("unseenTotal sums the three counters", () => {
    expect(unseenTotal({ permissions: 1, questions: 2, errors: 3 })).toBe(6);
  });

  it("projectRow + projectStatus: active / idle / paused", () => {
    const p = projectRow({ name: "chimera", path: "/code/chimera", origin: null, teams: ["tui-crew"], queue: "bugfix", sessions: 3, archived: false });
    expect(p).toMatchObject({ name: "chimera", teams: ["tui-crew"], sessions: 3, archived: false });
    expect(projectStatus(p)).toEqual({ glyph: "●", word: "active", tone: "success" });
    expect(projectStatus({ sessions: 0, archived: false })).toEqual({ glyph: "", word: "idle", tone: "faint" });
    expect(projectStatus({ sessions: 0, archived: true })).toEqual({ glyph: "◌", word: "paused", tone: "warn" });
  });

  it("sessionRow projects membership/branch/activity (resultText first line beats spec prompt)", () => {
    const s = sessionRow({
      agentId: "a1", state: "running", gitBranch: "main",
      membership: { team: "tui-crew", role: "dev" },
      spec: { conductor: false, prompt: "fix the tests" },
      resultText: "SEL-FIX done\nsecond line",
    });
    expect(s).toMatchObject({ agentId: "a1", state: "running", team: "tui-crew", role: "dev", branch: "main", activity: "SEL-FIX done" });
    const fallback = sessionRow({ agentId: "a2", state: "running", spec: { prompt: "kick off" } });
    expect(fallback.activity).toBe("kick off");
    expect(fallback.team).toBe(null);
    expect(fallback.branch).toBe(null);
  });

  // WORKFLOW-TASK-VIEW-2 (bug B): scheduler.ts forces spec.conductor:true on
  // every workflow-bound task spawn too (D12 session-liveness hack) — a
  // step agent (team membership present) must never project as `conductor`
  // in the project sessions table, or it renders "◆ main" there too.
  it("sessionRow: spec.conductor:true is NOT projected as conductor when the record also carries team membership", () => {
    const s = sessionRow({
      agentId: "step-1", state: "running",
      membership: { team: "team-chimera", role: "xp-glm" },
      spec: { conductor: true, prompt: "run step" },
    });
    expect(s.conductor).toBe(false);
    expect(s.team).toBe("team-chimera");
  });

  it("sessionRow: spec.conductor:true with no membership still projects conductor:true (a real conductor)", () => {
    const s = sessionRow({ agentId: "main", state: "running", spec: { conductor: true } });
    expect(s.conductor).toBe(true);
  });

  it("latestSessionSeq keys off status/result/agent_started/error only", () => {
    const events = [ev("a", "message_delta", { text: "x" }), ev("a", "agent_started", {})];
    expect(latestSessionSeq(events)).toBe(events[1]!.seq);
    expect(latestSessionSeq([ev("a", "message_delta", {})])).toBe(0);
  });
});

describe("filterProjects — SearchBox free-text query", () => {
  const rows = [
    projectRow({ name: "chimera", path: "/code/chimera", teams: [], sessions: 0, archived: false }),
    projectRow({ name: "widgets", path: "/code/other/widgets", teams: [], sessions: 0, archived: false }),
    projectRow({ name: "api-gateway", path: "/srv/chimera-api", teams: [], sessions: 0, archived: false }),
  ];

  it("an empty/blank query returns every row, same order", () => {
    expect(filterProjects(rows, "")).toEqual(rows);
    expect(filterProjects(rows, "   ")).toEqual(rows);
  });

  it("matches by name, case-insensitively", () => {
    expect(filterProjects(rows, "WIDGETS").map((p) => p.name)).toEqual(["widgets"]);
  });

  it("matches by path when the name doesn't match", () => {
    expect(filterProjects(rows, "other").map((p) => p.name)).toEqual(["widgets"]);
  });

  it("a query hitting both name and path substrings returns all matching rows", () => {
    expect(filterProjects(rows, "chimera").map((p) => p.name)).toEqual(["chimera", "api-gateway"]);
  });

  it("no match → empty result", () => {
    expect(filterProjects(rows, "nope")).toEqual([]);
  });
});

describe("import form", () => {
  it("requires a source OR a name; validates an explicit name against CoordName", () => {
    expect(validateImportForm({ source: "", name: "", team: "" })).toMatch(/source/);
    expect(validateImportForm({ source: "/x", name: "bad name!", team: "" })).toMatch(/name/);
    expect(validateImportForm({ source: "git@github.com:a/b.git", name: "", team: "" })).toBe(null);
    // PROJECT-DEFAULT-DIR: empty source + a valid name is a submittable BLANK create.
    expect(validateImportForm({ source: "", name: "blank-proj", team: "" })).toBe(null);
    expect(validateImportForm({ source: "", name: "bad name!", team: "" })).toMatch(/name/);
  });

  it("pins the selected conductor account and model before import or blank creation", () => {
    const form = { source: "/code/project", name: "project", team: "", conductorAccount: " codex-work ", conductorModel: " gpt-6-astra ", permissionProfile: "acceptEdits" as const };
    for (const build of [buildImportParams, buildCreateParams]) {
      expect(build(form)).toMatchObject({ conductorAccount: "codex-work", conductorModel: "gpt-6-astra", permissionProfile: "acceptEdits" });
      expect(build({ ...form, conductorAccount: "", conductorModel: "" })).not.toHaveProperty("conductorAccount");
    }
  });

  it("buildImportParams drops empty optionals", () => {
    expect(buildImportParams({ source: " /code/x ", name: "", team: "" })).toEqual({ source: "/code/x" });
    expect(buildImportParams({ source: "u", name: "n", team: "t" })).toEqual({ source: "u", name: "n", team: "t" });
  });

  it("isBlankProjectForm is true only when source is empty", () => {
    expect(isBlankProjectForm({ source: "", name: "blank-proj", team: "" })).toBe(true);
    expect(isBlankProjectForm({ source: "  ", name: "blank-proj", team: "" })).toBe(true);
    expect(isBlankProjectForm({ source: "/code/x", name: "", team: "" })).toBe(false);
  });

  it("buildCreateParams: name + optional team→teams array, no path (server defaults it)", () => {
    expect(buildCreateParams({ source: "", name: " blank-proj ", team: "" })).toEqual({ name: "blank-proj" });
    expect(buildCreateParams({ source: "", name: "blank-proj", team: "crew" })).toEqual({ name: "blank-proj", teams: ["crew"] });
  });

  // PROJECT-CREATE-GITINIT-OPTION: gitInit is only sent when explicitly false —
  // omitted/true both fall through to the daemon's own default (true).
  it("buildCreateParams: gitInit only appears in the params when explicitly false", () => {
    expect(buildCreateParams({ source: "", name: "blank-proj", team: "" })).toEqual({ name: "blank-proj" });
    expect(buildCreateParams({ source: "", name: "blank-proj", team: "", gitInit: true })).toEqual({ name: "blank-proj" });
    expect(buildCreateParams({ source: "", name: "blank-proj", team: "", gitInit: false })).toEqual({ name: "blank-proj", gitInit: false });
  });
});

describe("plugins catalog rows", () => {
  const entries = [
    { id: "skill:deep-research", kind: "skill", name: "deep-research", source: "~/.claude/skills/deep-research", enabled: true },
    { id: "command:deploy", kind: "command", name: "deploy", source: ".claude/commands/deploy.md", enabled: true },
    { id: "command:off", kind: "command", name: "off", source: ".claude/commands/off.md", enabled: false },
  ];

  it("catalogRows scopes commands to the project, everything else global", () => {
    const rows = catalogRows(entries, "chimera");
    expect(rows[0]).toMatchObject({ scope: "global", kind: "skill" });
    expect(rows[1]).toMatchObject({ scope: "proje · chimera", kind: "command", enabled: true });
    expect(rows[2]).toMatchObject({ enabled: false });
  });

  it("agentSkillRows adds spawn-spec skills minus global-catalog duplicates", () => {
    const catalog = catalogRows(entries, null);
    const rows = agentSkillRows(["deep-research", "dataviz"], "eager-weasel", catalog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "dataviz", scope: "agent · eager-weasel", source: "spawn spec", id: "skill:dataviz", enabled: true });
  });

  it("agentSkillRows reflects session-local toggle overrides (non-cataloged ids)", () => {
    const rows = agentSkillRows(["dataviz"], "eager-weasel", [], { "skill:dataviz": false });
    expect(rows[0]!.enabled).toBe(false);
  });

  it("projectCommandEntries filters enabled command rows by prefix, minus advertised names", () => {
    const catalog = catalogRows(entries, "chimera");
    expect(projectCommandEntries(catalog, "de", []).map((r) => r.name)).toEqual(["deploy"]);
    expect(projectCommandEntries(catalog, "", ["deploy"])).toEqual([]);   // advertised wins
    expect(projectCommandEntries(catalog, "of", []).map((r) => r.name)).toEqual([]); // disabled filtered
  });
});

describe("conductorAccountPin", () => {
  const live = (over: Record<string, unknown> = {}) => [{
    agentId: "c1", state: "running", accountName: "main", spec: { model: "sonnet" }, ...over,
  }];

  it("reads the pin off the project spec and the live account off the conductor's session row", () => {
    // Deliberately NOT off project.status's `conductor` field: that is {agentId,state} only, and a
    // core test pins that shape with a strict toEqual, so the account has to come from sessions[].
    const pin = conductorAccountPin({ conductorAccount: "cx", conductorModel: null, conductorId: "c1" }, live());
    expect(pin).toEqual({ account: "cx", model: null, permissionProfile: null, liveAccount: "main", restartRequired: true });
  });

  it("is quiet when the live conductor already matches, or when there is none", () => {
    const matched = conductorAccountPin({ conductorAccount: "main", conductorModel: "sonnet", conductorId: "c1" }, live());
    expect(matched.restartRequired).toBe(false);
    const dead = conductorAccountPin({ conductorAccount: "cx", conductorModel: null, conductorId: "c1" }, live({ state: "done" }));
    expect(dead).toEqual({ account: "cx", model: null, permissionProfile: null, liveAccount: null, restartRequired: false });
    const none = conductorAccountPin({ conductorAccount: null, conductorModel: null, conductorId: null }, []);
    expect(none).toEqual({ account: null, model: null, permissionProfile: null, liveAccount: null, restartRequired: false });
  });

  it("surfaces the project's permissionProfile, which the picker needs to keep a codex pin legal", () => {
    // The pane sends acceptEdits alongside a codex account because the daemon refuses the
    // "full" default for codex — it can only decide that if it can SEE the current profile.
    const pin = conductorAccountPin({ conductorAccount: "cx", conductorModel: null, permissionProfile: "acceptEdits", conductorId: null }, []);
    expect(pin.permissionProfile).toBe("acceptEdits");
  });

  it("flags a model-only difference, so pinning just the model still prompts a restart", () => {
    const pin = conductorAccountPin({ conductorAccount: null, conductorModel: "opus", conductorId: "c1" }, live());
    expect(pin.restartRequired).toBe(true);
  });
});
