import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname, relative } from "node:path";
import {
  EFFORT_ALIASES, EffortLevelSchema, PROVIDER_EFFORT_LEVELS,
  effortLevelsFor, effortRank, resolveEffortAlias,
} from "../src/index.js";

// EFFORT-ONE-SOURCE. Reported as "the effort dropdown is missing max" — it was missing `minimal`
// too. The cause was six independent hand-written copies of the level list across app/tui/core,
// with a comment in one of them asserting effort is "not something a provider publishes". It is
// published, PER MODEL, on a handshake chimera already consumes.

describe("the vocabulary itself", () => {
  it("is ordered cheapest to dearest, so a picker and a comparison cannot disagree", () => {
    expect(EffortLevelSchema.options).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(effortRank("minimal")).toBeLessThan(effortRank("low"));
    expect(effortRank("high")).toBeLessThan(effortRank("xhigh"));
    expect(effortRank("xhigh")).toBeLessThan(effortRank("max"));
  });

  it("is the UNION of the providers, which is why it is not the list to offer", () => {
    // claude has no "minimal"; codex has no "max". A single flat list is right for the wire and
    // wrong for a dropdown — that mismatch is what effortLevelsFor exists to resolve.
    expect(PROVIDER_EFFORT_LEVELS["claude"]).not.toContain("minimal");
    expect(PROVIDER_EFFORT_LEVELS["codex"]).not.toContain("max");
    for (const [provider, levels] of Object.entries(PROVIDER_EFFORT_LEVELS)) {
      for (const l of levels) {
        expect(EffortLevelSchema.options, `${provider} declares "${l}"`).toContain(l);
      }
    }
  });
});

describe("effortLevelsFor", () => {
  it("prefers what the provider said about THIS MODEL", () => {
    expect(effortLevelsFor({
      provider: "claude", model: "claude-opus-5",
      advertised: { "claude-opus-5": ["low", "high", "max"] },
    })).toEqual(["low", "high", "max"]);
  });

  it("does not assume the tiers are nested — a model can take max and NOT xhigh", () => {
    // Verified in the CLI's own model registry: claude-sonnet-4-6 and claude-opus-4-6 carry
    // "max_effort" without "xhigh_effort". Deriving one from the other would offer a tier the
    // model rejects.
    const levels = effortLevelsFor({ provider: "claude", model: "m", advertised: { m: ["low", "medium", "high", "max"] } });
    expect(levels).toContain("max");
    expect(levels).not.toContain("xhigh");
  });

  it("falls back to the provider's declared set before any session has spoken", () => {
    expect(effortLevelsFor({ provider: "claude" })).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevelsFor({ provider: "codex" })).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });

  it("falls back for a model the provider has said nothing about", () => {
    expect(effortLevelsFor({ provider: "claude", model: "unheard-of", advertised: { other: ["low"] } }))
      .toEqual(PROVIDER_EFFORT_LEVELS["claude"]);
  });

  it("offers the full vocabulary for an unknown provider rather than nothing", () => {
    // An empty dropdown is a dead control; offering a tier the backend ignores is that backend's
    // own documented passthrough.
    expect(effortLevelsFor({ provider: "some-new-thing" })).toEqual(EffortLevelSchema.options);
    expect(effortLevelsFor({})).toEqual(EffortLevelSchema.options);
  });

  it("falls back for a provider that only advertises at runtime (kimi) until it does", () => {
    expect(effortLevelsFor({ provider: "kimi" })).toEqual(EffortLevelSchema.options);
    expect(effortLevelsFor({ provider: "kimi", model: "k3", advertised: { k3: ["light", "deep"] } }))
      .toEqual(["light", "deep"]);
  });

  it("passes through a tier chimera's own enum has never heard of", () => {
    // Hiding a level the backend actually accepts, because a literal union here is out of date, is
    // a worse failure than showing one.
    expect(effortLevelsFor({ provider: "claude", model: "m", advertised: { m: ["low", "ludicrous"] } }))
      .toContain("ludicrous");
  });

  it("ignores an EMPTY advertised list rather than offering nothing", () => {
    expect(effortLevelsFor({ provider: "claude", model: "m", advertised: { m: [] } }))
      .toEqual(PROVIDER_EFFORT_LEVELS["claude"]);
  });
});

describe("aliases", () => {
  it("resolves ultracode to xhigh instead of inventing a seventh level", () => {
    // The CLI maps it exactly this way (`var O={ultracode:"xhigh"}`) and bundles session-scoped
    // workflow orchestration with it. The EFFORT half is xhigh; a separate level would mean the
    // same thing as one that already exists.
    expect(resolveEffortAlias("ultracode")).toBe("xhigh");
    expect(EFFORT_ALIASES["ultracode"]).toBe("xhigh");
    expect(EffortLevelSchema.options).not.toContain("ultracode");
  });

  it("resolves med to medium, and is case- and whitespace-insensitive", () => {
    expect(resolveEffortAlias("med")).toBe("medium");
    expect(resolveEffortAlias("  ULTRACODE ")).toBe("xhigh");
    expect(resolveEffortAlias("XHigh")).toBe("xhigh");
  });

  it("passes a real level through untouched", () => {
    for (const l of EffortLevelSchema.options) expect(resolveEffortAlias(l)).toBe(l);
  });

  it("REFUSES anything else rather than guessing a nearest tier", () => {
    expect(resolveEffortAlias("hihg")).toBeUndefined();
    expect(resolveEffortAlias("")).toBeUndefined();
    expect(resolveEffortAlias(undefined)).toBeUndefined();
    expect(resolveEffortAlias(null)).toBeUndefined();
  });
});

// The guard that keeps this from happening again: no source file may write the level list out by
// hand. This is the mechanism the old "never a separate source of truth" COMMENTS were supposed to
// be — and were not, because a copy is a source no matter what is written beside it.
describe("no file restates the level list", () => {
  const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
  const EXTS = new Set([".ts", ".tsx"]);
  // The declaration itself, and the one place allowed to name each provider's subset.
  const ALLOWED = new Set(["packages/protocol/src/effort.ts"]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (EXTS.has(extname(entry))) out.push(full);
    }
    return out;
  }

  it("finds no hand-written effort list outside protocol's own declaration", () => {
    // Three or more adjacent quoted levels in one expression is a list, not a mention.
    const LIST = /(["'])(minimal|low|medium|high|xhigh|max)\1\s*,\s*(["'])(minimal|low|medium|high|xhigh|max)\3\s*,\s*(["'])(minimal|low|medium|high|xhigh|max)\5/;
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "packages"))) {
      const rel = relative(ROOT, file).replaceAll("\\", "/");
      if (ALLOWED.has(rel) || rel.includes("/test/")) continue;
      const src = readFileSync(file, "utf8");
      // Strip line comments: prose naming the levels (which several files legitimately do to
      // explain the mapping) is documentation, not a second source.
      const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*")).join("\n");
      if (LIST.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
