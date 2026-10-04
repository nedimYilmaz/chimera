import { describe, expect, it } from "vitest";
import {
  accessSegments,
  cursoredProfile,
  effectiveMode,
  fmtScanAge,
  modeTone,
  nextPolicyMode,
  parseHostToolsReply,
  profileParts,
  shapeHostRows,
  type HostToolEntry,
  type HostToolsReply,
} from "../src/state/selectors.host";

// W8 gate (a): row shaping / rollup / profile tinting / policy cycle
// transitions — the pure layer under the HostToolsCard (mock lines 409-431,
// coverage B14).

const tool = (t: string, version: string, profiles: string[] = [], policy: Record<string, string> = {}): HostToolEntry =>
  ({ tool: t, version, profiles, policy });

/** The mock's local machine, 1:1 (kubectl/aws/gcloud primary + 3 rollup tools). */
const mockLocal = (): HostToolsReply => ({
  host: "mbp",
  tools: [
    tool("kubectl", "1.31", ["prod", "staging", "dev"], { prod: "ask", "*": "allow" }),
    tool("aws", "2.17", ["default", "acmecorp-prod"], { "acmecorp-prod": "deny", "*": "allow" }),
    tool("gcloud", "502", ["alice@acmecorp.com"], { "*": "deny" }),
    tool("gh", "2.55", ["alice"]),
    tool("docker", "27.1"),
    tool("terraform", "1.9"),
  ],
});

const mockPeer = (): HostToolsReply => ({
  host: "studio",
  tools: [tool("kubectl", "1.30", ["homelab"]), tool("aws", "2.15", ["default"])],
});

describe("policy cycle transitions (coverage B14: space allow→ask→deny)", () => {
  it("cycles allow → ask → deny → allow", () => {
    expect(nextPolicyMode("allow")).toBe("ask");
    expect(nextPolicyMode("ask")).toBe("deny");
    expect(nextPolicyMode("deny")).toBe("allow");
  });
  it("maps each mode to the mock's tone", () => {
    expect(modeTone("allow")).toBe("success");
    expect(modeTone("ask")).toBe("warn");
    expect(modeTone("deny")).toBe("danger");
  });
});

describe("effectiveMode (ToolPolicyStore display-view mirror)", () => {
  it("profile-specific beats wildcard; unset ⇒ allow", () => {
    const e = tool("kubectl", "1.31", [], { prod: "ask", "*": "deny" });
    expect(effectiveMode(e, "prod")).toBe("ask");
    expect(effectiveMode(e, "staging")).toBe("deny");   // wildcard fallback
    expect(effectiveMode(e, null)).toBe("deny");        // wildcard row itself
    expect(effectiveMode(tool("gh", "1"), "x")).toBe("allow");
  });
  it("ignores non-mode garbage defensively", () => {
    const e = { policy: { "*": "nonsense" } };
    expect(effectiveMode(e, null)).toBe("allow");
  });
});

describe("access column segments (mock: 'ask prod · allow staging, dev')", () => {
  it("groups profiles by effective mode in first-occurrence order", () => {
    const [k] = mockLocal().tools;
    expect(accessSegments(k!)).toEqual([
      { mode: "ask", names: "prod" },
      { mode: "allow", names: "staging, dev" },
    ]);
  });
  it("renders a single shared mode bare (mock gcloud: 'deny')", () => {
    const gcloud = mockLocal().tools[2]!;
    expect(accessSegments(gcloud)).toEqual([{ mode: "deny", names: null }]);
  });
  it("renders the bare wildcard mode when a tool has no profiles", () => {
    expect(accessSegments(tool("docker", "27.1"))).toEqual([{ mode: "allow", names: null }]);
    expect(accessSegments(tool("docker", "27.1", [], { "*": "ask" }))).toEqual([{ mode: "ask", names: null }]);
  });
});

describe("profiles cell tinting (DENIED names tint danger)", () => {
  it("tints deny'd profiles danger, leaves ask/allow plain", () => {
    const e = tool("aws", "2.17", ["default", "acmecorp-prod"], { "acmecorp-prod": "deny", default: "ask" });
    expect(profileParts(e)).toEqual([
      { text: "default", danger: false },       // ask is NOT danger — only deny tints
      { text: "acmecorp-prod", danger: true },
    ]);
  });
  it("tints via the wildcard too (all-deny tool)", () => {
    const e = tool("gcloud", "502", ["alice@acmecorp.com"], { "*": "deny" });
    expect(profileParts(e)).toEqual([{ text: "alice@acmecorp.com", danger: true }]);
  });
});

describe("row shaping (HOST-TOOLS-PER-ROW: one row per discovered tool, no rollup)", () => {
  it("gives every tool its own row, primary tools (kubectl/aws/gcloud) sorted first", () => {
    const rows = shapeHostRows(mockLocal());
    expect(rows.map((r) => r.name)).toEqual(["kubectl", "aws", "gcloud", "gh", "docker", "terraform"]);
    expect(rows[0]!.hostMark).toBe("◆ mbp");                       // first-row marker only
    expect(rows.slice(1).every((r) => r.hostMark === null)).toBe(true);
    expect(rows[0]!.profileLabel).toBe("ctx");
    expect(rows[1]!.profileLabel).toBe("profiles");
    expect(rows[2]!.profileLabel).toBe("auth");
    // non-primary tools have no special label, but still get their own full row
    expect(rows[3]!.profileLabel).toBeNull();
    expect(rows[3]!.version).toBe("2.55");
    expect(rows[3]!.profileParts).toEqual([
      { text: "default (*)", danger: false },
      { text: "alice", danger: false },
    ]);
    expect(rows[4]!.version).toBe("27.1");
    expect(rows[4]!.profileParts).toEqual([{ text: "default (*)", danger: false }]);   // no named profiles
  });
  it("every tool row is its own wildcard-cycle target and carries its own p-edit targets", () => {
    const rows = shapeHostRows(mockLocal());
    const gh = rows[3]!;
    expect(gh.cycleTools).toEqual(["gh"]);
    expect(gh.profileTools).toEqual([
      { tool: "gh", profile: "*" },
      { tool: "gh", profile: "alice" },
    ]);
    const docker = rows[4]!;
    expect(docker.cycleTools).toEqual(["docker"]);
    expect(docker.profileTools).toEqual([{ tool: "docker", profile: "*" }]);   // default (*) only ⇒ still editable
  });
  it("each row's access reflects only that tool's policy (no cross-tool collapsing)", () => {
    const local: HostToolsReply = {
      host: "mbp",
      tools: [tool("gh", "2.55"), tool("docker", "27.1", [], { "*": "deny" })],
    };
    const rows = shapeHostRows(local);
    expect(rows[0]!.access).toEqual([{ mode: "allow", names: "default (*)" }]);
    expect(rows[1]!.access).toEqual([{ mode: "deny", names: "default (*)" }]);
  });
  it("primary rows carry (tool, profile) p-edit targets, default (*) first", () => {
    const rows = shapeHostRows(mockLocal());
    expect(rows[0]!.profileTools).toEqual([
      { tool: "kubectl", profile: "*" },
      { tool: "kubectl", profile: "prod" },
      { tool: "kubectl", profile: "staging" },
      { tool: "kubectl", profile: "dev" },
    ]);
  });
  it("null local reply shapes no rows", () => {
    expect(shapeHostRows(null)).toEqual([]);
  });
  it("N discovered tools yield N rows — no rollup regardless of how many non-primary tools exist", () => {
    const local: HostToolsReply = {
      host: "mbp",
      tools: [
        tool("kubectl", "1.35.0", ["k3s"], { "*": "allow" }),
        tool("gh", "2.60.0", ["cloudifytech-root"]),
        tool("docker", "29.0.1", ["desktop"]),
        tool("node", "22.11.0"),
        tool("npm", "10.9.0"),
        tool("terraform", "1.9.0"),
      ],
    };
    const rows = shapeHostRows(local);
    expect(rows).toHaveLength(local.tools.length);
    expect(rows.map((r) => r.name)).toEqual(["kubectl", "gh", "docker", "node", "npm", "terraform"]);
    expect(rows.every((r) => r.name.includes(" · "))).toBe(false);   // never a joined rollup name
  });
});

describe("default (*) per-profile entry (HOST-TOOLS-DEFAULT-POLICY-UI)", () => {
  it("leads profileTools for every local tool, with or without named contexts", () => {
    const rows = shapeHostRows(mockLocal());
    for (const row of rows) expect(row.profileTools[0]).toEqual({ tool: row.name, profile: "*" });
    // terraform has zero named contexts — the default is still its only p-edit target
    const terraform = rows.find((r) => r.name === "terraform")!;
    expect(terraform.profileTools).toEqual([{ tool: "terraform", profile: "*" }]);
  });
  it("access cell carries the default mode distinctly, ahead of named-context groups", () => {
    const rows = shapeHostRows(mockLocal());
    const kubectl = rows[0]!;   // policy: { prod: "ask", "*": "allow" }
    expect(kubectl.access[0]).toEqual({ mode: "allow", names: "default (*)" });
    expect(kubectl.access.slice(1)).toEqual([
      { mode: "ask", names: "prod" },
      { mode: "allow", names: "staging, dev" },
    ]);
  });
  it("cycling the default (*) p-edit target writes profile '*'", () => {
    // mirrors commands.host.ts cycle(): profileCursor 0 → row.profileTools[0] → {tool, profile:"*"}
    const rows = shapeHostRows(mockLocal());
    const target = rows[0]!.profileTools[0]!;
    expect(target).toEqual({ tool: "kubectl", profile: "*" });
    expect(effectiveMode({ policy: { prod: "ask", "*": "allow" } }, target.profile)).toBe("allow");
  });
  it("remote rows never get a default (*) entry — read-only, policy is the peer's", () => {
    const rows = shapeHostRows(mockLocal(), [mockPeer()]);
    const remote = rows.find((r) => r.remote)!;
    expect(remote.profileTools).toEqual([]);
    expect(remote.profileParts.some((p) => p.text === "default (*)")).toBe(false);
  });
});

describe("cursoredProfile (footer-caption input — HOST-TOOLS-PROFILE-VISIBILITY)", () => {
  it("captions the default (*) entry (cursor 0)", () => {
    const rows = shapeHostRows(mockLocal());
    const reply = mockLocal();
    const kubectl = rows[0]!;                          // policy: { prod: "ask", "*": "allow" }
    expect(cursoredProfile(kubectl, reply, 0)).toEqual({
      toolName: "kubectl",
      profileText: "default (*)",
      mode: "allow",
    });
  });
  it("captions a named profile once the cursor moves onto it", () => {
    const rows = shapeHostRows(mockLocal());
    const reply = mockLocal();
    const kubectl = rows[0]!;                          // profileTools: [*, prod, staging, dev]
    expect(cursoredProfile(kubectl, reply, 1)).toEqual({
      toolName: "kubectl",
      profileText: "prod",
      mode: "ask",
    });
  });
  it("returns null in row mode (no cursor)", () => {
    const rows = shapeHostRows(mockLocal());
    expect(cursoredProfile(rows[0]!, mockLocal(), null)).toBeNull();
  });
  it("returns null for a remote/peer row even with a cursor index", () => {
    const rows = shapeHostRows(mockLocal(), [mockPeer()]);
    const remote = rows.find((r) => r.remote)!;
    expect(cursoredProfile(remote, mockLocal(), 0)).toBeNull();
  });
  it("returns null defensively when the row or its entry can't be found", () => {
    expect(cursoredProfile(undefined, mockLocal(), 0)).toBeNull();
    const rows = shapeHostRows(mockLocal());
    expect(cursoredProfile(rows[0]!, null, 0)).toBeNull();          // no reply ⇒ no entry lookup
    expect(cursoredProfile(rows[0]!, mockLocal(), 99)).toBeNull();  // out-of-range cursor
  });
});

describe("remote ⇅ peer rows (read-only; policy is the peer's — B14)", () => {
  it("expands a peer to one row per tool, host-mark on the first, all read-only with the peer-policy note", () => {
    const rows = shapeHostRows(mockLocal(), [mockPeer()]);
    const [k, aws] = rows.slice(mockLocal().tools.length);
    expect(k!.remote).toBe(true);
    expect(k!.sep).toBe(true);                                  // mock line 423 separator, first peer row only
    expect(k!.hostMark).toBe("⇅ studio");
    expect(k!.name).toBe("kubectl");
    expect(k!.version).toBe("1.30");
    expect(k!.profileLabel).toBe("ctx");
    expect(k!.profileParts).toEqual([{ text: "homelab", danger: false }]);
    expect(k!.access).toEqual([{ mode: "allow", names: null }]);
    expect(k!.peerNote).toBe("(peer policy — studio decides)");
    expect(k!.cycleTools).toEqual([]);                          // never a mutation target
    expect(k!.profileTools).toEqual([]);
    expect(aws!.hostMark).toBeNull();                           // host mark only on the peer's first row
    expect(aws!.sep).toBe(false);
    expect(aws!.name).toBe("aws");
    expect(aws!.version).toBe("2.15");
  });
  it("degraded state: no peer carriage ⇒ no remote rows (PLAN §7 W8)", () => {
    expect(shapeHostRows(mockLocal()).some((r) => r.remote)).toBe(false);
  });
});

describe("parseHostToolsReply (defensive over the wire shape)", () => {
  it("parses the engine reply 1:1", () => {
    const parsed = parseHostToolsReply({
      host: "mbp",
      tools: [{ tool: "kubectl", version: "1.31", profiles: ["prod"], policy: { "*": "allow" } }],
    });
    expect(parsed).toEqual({
      host: "mbp",
      tools: [{ tool: "kubectl", version: "1.31", profiles: ["prod"], policy: { "*": "allow" } }],
    });
  });
  it("nulls unreadable shapes and drops garbage rows/values", () => {
    expect(parseHostToolsReply(null)).toBeNull();
    expect(parseHostToolsReply("nope")).toBeNull();
    expect(parseHostToolsReply({ host: "mbp" })).toBeNull();
    const parsed = parseHostToolsReply({
      host: "mbp",
      tools: [{ tool: "kubectl", version: 7, profiles: ["a", 3], policy: { "*": "explode" } }, { nope: true }, null],
    });
    expect(parsed).toEqual({ host: "mbp", tools: [{ tool: "kubectl", version: "", profiles: ["a"], policy: {} }] });
  });
});

describe("scan-age header label (client-side fetch age — reply has no scannedAt)", () => {
  it("formats the mock's 'last scan 4m ago'", () => {
    expect(fmtScanAge(0, 4 * 60_000)).toBe("last scan 4m ago");
  });
  it("says 'just now' under a minute and 'scanning…' before the first fetch", () => {
    expect(fmtScanAge(0, 30_000)).toBe("last scan just now");
    expect(fmtScanAge(null, 1)).toBe("scanning…");
  });
});
