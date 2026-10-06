import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { Engine } from "@chimera/core/engine";
import type { AgentBackend } from "@chimera/core/backend";
import { CLIENT_CAP_UI_COMPONENTS } from "@chimera/protocol";
import { OUTPUT_COMPONENTS_CHEATSHEET } from "@chimera/core/output-components";
import { CFG, fakeExec, makeSupervisor } from "./helpers.js";
import { makeEngineHome } from "./helpers.js";

function makeGatedSupervisor(uiComponentsEnabled?: () => boolean) {
  const dir = mkdtempSync(join(tmpdir(), "chimera-sup-oc-"));
  const fake = new FakeAgentBackend([]);
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(CFG),
    credentials: new CredentialResolver(fakeExec),
    backends: new Map([["claude", fake]]),
    events: new EventLog(dir),
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    permissionTimeoutMs: 100,
    ...(uiComponentsEnabled ? { uiComponentsEnabled } : {}),
  });
  return { sup, fake };
}

describe("AgentSupervisor: F21/D17 output-components cheatsheet gate", () => {
  it("omits the cheatsheet when uiComponentsEnabled is absent (byte-identical to pre-D17)", async () => {
    const { sup, fake } = makeGatedSupervisor();
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    expect(fake.spawns[0]!.instructions).toBeUndefined();
  });

  it("omits the cheatsheet when uiComponentsEnabled returns false", async () => {
    const { sup, fake } = makeGatedSupervisor(() => false);
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    expect(fake.spawns[0]!.instructions).toBeUndefined();
  });

  it("appends the cheatsheet verbatim when uiComponentsEnabled returns true", async () => {
    const { sup, fake } = makeGatedSupervisor(() => true);
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    expect(fake.spawns[0]!.instructions).toBe(OUTPUT_COMPONENTS_CHEATSHEET);
  });

  it("is read fresh per launch, not snapshotted at supervisor construction", async () => {
    let enabled = false;
    const { sup, fake } = makeGatedSupervisor(() => enabled);
    // Distinct accounts (not sequencing/timing) keep this deterministic regardless of
    // how fast the fake backend's default scenario settles the first agent to "done".
    await sup.spawn({ prompt: "first", cwd: "/tmp", isolation: "none", account: "main" });
    expect(fake.spawns[0]!.instructions).toBeUndefined();
    enabled = true;
    await sup.spawn({ prompt: "second", cwd: "/tmp", isolation: "none", account: "second" });
    expect(fake.spawns[1]!.instructions).toBe(OUTPUT_COMPONENTS_CHEATSHEET);
  });

  // TOKEN-OPT-CACHE-PREFIX: the SHARED blocks lead and the caller's own instructions follow.
  // Anthropic's prompt cache matches on an exact prefix, so with per-agent instructions in front
  // — where they used to be — two agents shared no prefix at all and every spawn re-created this
  // identical text as fresh tokens. Order is a token decision here, not a presentation one.
  it("puts the shared AWARENESS blocks BEFORE the caller's instructions, so they cache across agents", async () => {
    const { sup, fake } = makeGatedSupervisor(() => true);
    await sup.spawn({
      prompt: "hi", cwd: "/tmp", isolation: "none", instructions: "role instructions",
      orchestration: { allow: true, maxDepth: 1 },
    });
    const text = fake.spawns[0]!.instructions!;
    const roleIdx = text.indexOf("role instructions");
    const capIdx = text.indexOf("CHIMERA TOOLS");
    const cheatsheetIdx = text.indexOf("OUTPUT COMPONENTS");
    expect(capIdx).toBe(0);                          // the very first byte is shared
    expect(cheatsheetIdx).toBeGreaterThan(capIdx);
    expect(roleIdx).toBeGreaterThan(cheatsheetIdx);  // the per-agent part is last
  });

  it("everything before the caller's instructions is agent-INDEPENDENT — which is what makes it cacheable", async () => {
    const { sup, fake } = makeGatedSupervisor(() => true);
    await sup.spawn({
      prompt: "hi", cwd: "/tmp", isolation: "none", instructions: "you are the frontend agent",
      orchestration: { allow: true, maxDepth: 1 },
    });
    const text = fake.spawns[0]!.instructions!;
    const preamble = text.slice(0, text.indexOf("you are the frontend agent"));
    // nothing in the preamble came from this spawn: no cwd, no agent id, no role text
    expect(preamble.length).toBeGreaterThan(500);
    expect(preamble).not.toContain("frontend");
    expect(preamble).not.toContain("/tmp");
  });

  it("existing makeSupervisor() callers (no uiComponentsEnabled dep at all) stay byte-identical", async () => {
    const { sup, fake } = makeSupervisor([]);
    await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    expect(fake.spawns[0]!.instructions).toBeUndefined();
  });
});

describe("Engine: F21/D17 client capability registry", () => {
  it("hasClientCap is false with no declarations", () => {
    const e = new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
    expect(e.hasClientCap(CLIENT_CAP_UI_COMPONENTS)).toBe(false);
  });

  it("declareClientCaps flips hasClientCap true; releaseClientCaps flips it back", () => {
    const e = new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
    const conn = {};
    e.declareClientCaps(conn, [CLIENT_CAP_UI_COMPONENTS]);
    expect(e.hasClientCap(CLIENT_CAP_UI_COMPONENTS)).toBe(true);
    e.releaseClientCaps(conn);
    expect(e.hasClientCap(CLIENT_CAP_UI_COMPONENTS)).toBe(false);
  });

  it("ignores unrecognized capability strings", () => {
    const e = new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
    e.declareClientCaps({}, ["something.else"]);
    expect(e.hasClientCap(CLIENT_CAP_UI_COMPONENTS)).toBe(false);
  });

  it("stays true while ANY connection still declares it (a plain CLI connection alongside a UI one)", () => {
    const e = new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
    const uiConn = {}; const cliConn = {};
    e.declareClientCaps(uiConn, [CLIENT_CAP_UI_COMPONENTS]);
    e.declareClientCaps(cliConn, []);   // plain CLI subscribe: declares nothing
    expect(e.hasClientCap(CLIENT_CAP_UI_COMPONENTS)).toBe(true);
    e.releaseClientCaps(cliConn);
    expect(e.hasClientCap(CLIENT_CAP_UI_COMPONENTS)).toBe(true);   // the UI connection is still live
    e.releaseClientCaps(uiConn);
    expect(e.hasClientCap(CLIENT_CAP_UI_COMPONENTS)).toBe(false);
  });

  it("re-declaring on the same connection REPLACES its prior set (not additive)", () => {
    const e = new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]) });
    const conn = {};
    e.declareClientCaps(conn, [CLIENT_CAP_UI_COMPONENTS]);
    e.declareClientCaps(conn, []);
    expect(e.hasClientCap(CLIENT_CAP_UI_COMPONENTS)).toBe(false);
  });

  it("end-to-end: a fresh spawn on an Engine with the capability declared carries the cheatsheet; without it, byte-identical", async () => {
    const fake = new FakeAgentBackend([]);
    const e = new Engine({ home: makeEngineHome(), backends: new Map<string, AgentBackend>([["claude", fake]]) });
    await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } });
    expect(fake.spawns[0]!.instructions).toBeUndefined();

    e.declareClientCaps({}, [CLIENT_CAP_UI_COMPONENTS]);
    await e.handle("agent.spawn", { spec: { prompt: "hello again", cwd: "/tmp", isolation: "none" } });
    expect(fake.spawns[1]!.instructions).toBe(OUTPUT_COMPONENTS_CHEATSHEET);
  });
});
