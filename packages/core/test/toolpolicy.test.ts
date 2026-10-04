import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolPolicyStore, parseBashTargets } from "@chimera/core/hosttools";

// WD Stage 2 (coverage B14): the toolPolicy store (config field + toolpolicy.json
// overlay, documented precedence) and the Bash argv/env parsing the supervisor's
// decidePermission gate consumes.

describe("ToolPolicyStore precedence", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "chimera-pol-"));

  it("defaults to allow for unlisted tools and profiles", () => {
    const store = new ToolPolicyStore(dir());
    expect(store.modeFor("kubectl", null)).toBe("allow");
    expect(store.modeFor("kubectl", "prod")).toBe("allow");
    expect(store.policyFor("kubectl")).toEqual({});
  });

  // GATED-BUT-ALLOWED-INVISIBLE: hasExplicitPolicy distinguishes "this tool's access is
  // actually CONDITIONAL somewhere" from both "no row at all" (allow falls to the hardcoded
  // default) AND "configured, but uniformly allow everywhere" — modeFor's return value alone
  // can't tell any of these apart (all resolve to "allow").
  it("hasExplicitPolicy: false for a tool with no configured row in either layer (the noise case)", () => {
    const store = new ToolPolicyStore(dir());
    expect(store.hasExplicitPolicy("head")).toBe(false);
  });

  it("hasExplicitPolicy: true when config.json has a non-allow row (deny/ask) for the tool", () => {
    const store = new ToolPolicyStore(dir(), { kubectl: { "*": "deny" } });
    expect(store.hasExplicitPolicy("kubectl")).toBe(true);
  });

  it("hasExplicitPolicy: true when ONLY the overlay has a non-allow row (config layer has nothing)", () => {
    const home = dir();
    const store = new ToolPolicyStore(home);
    store.set("aws", "prod", "ask");
    expect(store.hasExplicitPolicy("aws")).toBe(true);
  });

  // REAL-DATA CORRECTION: a first cut treated "any configured row, even a uniform allow" as
  // gated — sanity-checked against this machine's real capability_decision archive, that was
  // WRONG: `gh: {"*": "allow"}` (configured for audit visibility only, never actually gates
  // anything) accounted for 285 of 421 "gated" hits in a ~4200-event sample, drowning the 136
  // genuinely interesting kubectl ones. A tool configured ONLY with allow rows never behaves
  // differently from an unconfigured one — it must read as noise, same as `head`/`wc`.
  it("hasExplicitPolicy: FALSE for a tool configured with ONLY allow rows (uniformly frictionless by design, not gated)", () => {
    const store = new ToolPolicyStore(dir(), { gh: { "*": "allow" } });
    expect(store.hasExplicitPolicy("gh")).toBe(false);
    const storeMulti = new ToolPolicyStore(dir(), { gh: { "*": "allow", "github.com": "allow" } });
    expect(storeMulti.hasExplicitPolicy("gh")).toBe(false);
  });

  // The real production kubectl shape: a wildcard deny with several named-context allow
  // exceptions. An allowed context's call SHOULD flag (it dodged the deny every OTHER context
  // hits) even though the SPECIFIC row that resolved it says "allow".
  it("hasExplicitPolicy: true for an allow-resolving profile when the SAME tool has a deny row elsewhere", () => {
    const store = new ToolPolicyStore(dir(), { kubectl: { "*": "deny", "eks-qa": "allow" } });
    expect(store.modeFor("kubectl", "eks-qa")).toBe("allow");
    expect(store.hasExplicitPolicy("kubectl")).toBe(true);
  });

  it("config.json's toolPolicy applies: wildcard catches profile-less AND unmatched-profile calls", () => {
    const store = new ToolPolicyStore(dir(), { kubectl: { "*": "ask" } });
    expect(store.modeFor("kubectl", null)).toBe("ask");
    expect(store.modeFor("kubectl", "staging")).toBe("ask");
    expect(store.modeFor("aws", null)).toBe("allow");
  });

  it("profile-specific beats wildcard (same layer)", () => {
    const store = new ToolPolicyStore(dir(), { kubectl: { "*": "allow", prod: "deny" } });
    expect(store.modeFor("kubectl", "prod")).toBe("deny");
    expect(store.modeFor("kubectl", "staging")).toBe("allow");
    expect(store.modeFor("kubectl", null)).toBe("allow");
  });

  it("set() persists to the overlay and wins over config at the same specificity", () => {
    const home = dir();
    const store = new ToolPolicyStore(home, { kubectl: { prod: "allow" } });
    store.set("kubectl", "prod", "deny");
    expect(store.modeFor("kubectl", "prod")).toBe("deny");
    // reload → the overlay file carries the mutation (config.json untouched by design)
    const reloaded = new ToolPolicyStore(home, { kubectl: { prod: "allow" } });
    expect(reloaded.modeFor("kubectl", "prod")).toBe("deny");
    expect(JSON.parse(readFileSync(join(home, "toolpolicy.json"), "utf8"))).toEqual({ kubectl: { prod: "deny" } });
  });

  it("a profile-specific CONFIG rule still beats an overlay WILDCARD (specificity first, then layer)", () => {
    const home = dir();
    const store = new ToolPolicyStore(home, { kubectl: { prod: "deny" } });
    store.set("kubectl", "*", "allow");
    expect(store.modeFor("kubectl", "prod")).toBe("deny");     // specific config > wildcard overlay
    expect(store.modeFor("kubectl", "staging")).toBe("allow"); // wildcard overlay applies where nothing specific exists
  });

  it("policyFor merges config and overlay per profile, overlay winning per key", () => {
    const home = dir();
    const store = new ToolPolicyStore(home, { kubectl: { "*": "ask", prod: "allow" } });
    store.set("kubectl", "prod", "deny");
    expect(store.policyFor("kubectl")).toEqual({ "*": "ask", prod: "deny" });
  });

  it("fails fast on a corrupt toolpolicy.json (a silently-dropped deny rule is a security hole)", () => {
    const home = dir();
    writeFileSync(join(home, "toolpolicy.json"), "{nope");
    expect(() => new ToolPolicyStore(home)).toThrow(/corrupt coordination state in .*toolpolicy\.json/);
  });
});

// MCP-FOREIGN-POLICY: modeForMcpMaybe is the foreign-MCP lookup — it returns null for "unset"
// (so the broker can ask-by-default) rather than collapsing to "allow" like modeFor. Keys are
// the exact tool name (wins) or the server key; only the "*" wildcard row is consulted.
describe("ToolPolicyStore.modeForMcpMaybe (foreign MCP lookup)", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "chimera-mcppol-"));
  const T = "mcp__ekb__search";
  const S = "mcp__ekb";

  it("returns null when nothing is configured (the ASK-by-default signal, distinct from allow)", () => {
    expect(new ToolPolicyStore(dir()).modeForMcpMaybe(T, S)).toBeNull();
  });

  it("a server-key entry applies to every tool of that server", () => {
    const store = new ToolPolicyStore(dir(), { [S]: { "*": "allow" } });
    expect(store.modeForMcpMaybe(T, S)).toBe("allow");
    expect(store.modeForMcpMaybe("mcp__ekb__lookup", S)).toBe("allow");
  });

  it("an exact tool-name entry wins over the server-key entry (any layer)", () => {
    const store = new ToolPolicyStore(dir(), { [S]: { "*": "deny" }, [T]: { "*": "allow" } });
    expect(store.modeForMcpMaybe(T, S)).toBe("allow");
    expect(store.modeForMcpMaybe("mcp__ekb__other", S)).toBe("deny"); // no exact entry → server key
  });

  it("overlay wins over config within the same key", () => {
    const home = dir();
    const store = new ToolPolicyStore(home, { [T]: { "*": "deny" } });
    store.set(T, "*", "allow");
    expect(store.modeForMcpMaybe(T, S)).toBe("allow");
  });

  it("only the '*' row is consulted (a non-'*' profile key is ignored for MCP)", () => {
    const store = new ToolPolicyStore(dir(), { [T]: { someProfile: "deny" } });
    expect(store.modeForMcpMaybe(T, S)).toBeNull();
  });
});

describe("parseBashTargets (argv/env detection)", () => {
  it("first token is the tool; no flags → null profile", () => {
    expect(parseBashTargets("kubectl get pods")).toEqual([{ tool: "kubectl", profile: null }]);
  });

  it("kubectl --context in both space and = forms", () => {
    expect(parseBashTargets("kubectl --context prod get pods")).toEqual([{ tool: "kubectl", profile: "prod" }]);
    expect(parseBashTargets("kubectl get pods --context=prod")).toEqual([{ tool: "kubectl", profile: "prod" }]);
  });

  it("aws --profile, plus the AWS_PROFILE env-assignment prefix as fallback", () => {
    expect(parseBashTargets("aws --profile work s3 ls")).toEqual([{ tool: "aws", profile: "work" }]);
    expect(parseBashTargets("AWS_PROFILE=prod aws s3 ls")).toEqual([{ tool: "aws", profile: "prod" }]);
    // an explicit flag beats the env prefix
    expect(parseBashTargets("AWS_PROFILE=prod aws --profile=dev s3 ls")).toEqual([{ tool: "aws", profile: "dev" }]);
  });

  it("gcloud --account primary, --project fallback; gh --hostname", () => {
    expect(parseBashTargets("gcloud --account me@x.com compute instances list")).toEqual([{ tool: "gcloud", profile: "me@x.com" }]);
    expect(parseBashTargets("gcloud compute list --project=acme-prod")).toEqual([{ tool: "gcloud", profile: "acme-prod" }]);
    expect(parseBashTargets("gh --hostname ghe.corp pr list")).toEqual([{ tool: "gh", profile: "ghe.corp" }]);
  });

  it("scans EVERY pipeline/sequence segment, so a cd-prefix cannot mask the tool", () => {
    expect(parseBashTargets("cd /x && kubectl --context prod apply -f a.yaml")).toEqual([
      { tool: "cd", profile: null }, { tool: "kubectl", profile: "prod" },
    ]);
    expect(parseBashTargets("kubectl get pods | grep web; aws --profile prod s3 ls")).toEqual([
      { tool: "kubectl", profile: null }, { tool: "grep", profile: null }, { tool: "aws", profile: "prod" },
    ]);
  });

  it("a path-invoked tool still matches by basename", () => {
    expect(parseBashTargets("/usr/local/bin/kubectl --context prod get pods")).toEqual([{ tool: "kubectl", profile: "prod" }]);
  });

  it("quoting is respected: a quoted '&&' or flag value stays inside its token", () => {
    expect(parseBashTargets("echo 'kubectl && aws'")).toEqual([{ tool: "echo", profile: null }]);
    expect(parseBashTargets('kubectl --context "prod cluster" get pods')).toEqual([{ tool: "kubectl", profile: "prod cluster" }]);
  });

  it("empty/whitespace commands parse to no targets", () => {
    expect(parseBashTargets("")).toEqual([]);
    expect(parseBashTargets("   \n  ")).toEqual([]);
  });
});
