import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChimeraConfigSchema } from "@chimera/protocol";
import { AccountRegistry } from "@chimera/core/accounts";
import { CredentialResolver } from "@chimera/core/credentials";
import { EventLog } from "@chimera/core/events";
import { MailboxStore } from "@chimera/core/mailbox";
import { CooldownTracker } from "@chimera/core/failover";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { SentenceChunker } from "@chimera/core/voice-tts";
import { CFG, fakeExec, CODEX_HOME_A } from "./helpers.js";

const CODEX_CFG = ChimeraConfigSchema.parse({
  accounts: [{ name: "cx-main", provider: "codex", auth: { type: "env", var: "CODEX_KEY_SRC", injectAs: "OPENAI_API_KEY", homeDir: CODEX_HOME_A } }],
  autoOrder: ["cx-main"],
  caps: { maxAgentsTotal: 2, perAccount: {} },
});
const codexEnv = { CODEX_KEY_SRC: "sk-codex" } as NodeJS.ProcessEnv;

// VOICE S4 (docs/superpowers/specs/2026-07-24-voice-agents-design.md §5/§10): the shared
// EventSink tap in supervisor.ts's onEvent — ONE tap serves both claude and codex fakes here,
// mirroring the design's "one consumer, both providers" requirement.

describe("SentenceChunker", () => {
  it("waits for a confirming char before cutting on . ! ?", () => {
    const c = new SentenceChunker();
    expect(c.push("Hello wor")).toEqual([]);
    expect(c.push("ld. How are you")).toEqual(["Hello world."]);
    expect(c.push("?")).toEqual([]);           // "?" at buffer end — not yet confirmed
    expect(c.flush()).toBe("How are you?");
  });

  it("cuts immediately on a bare newline", () => {
    const c = new SentenceChunker();
    expect(c.push("line one\nline two")).toEqual(["line one"]);
    expect(c.flush()).toBe("line two");
  });

  it("does not cut on a mid-number/abbreviation period with no trailing whitespace yet", () => {
    const c = new SentenceChunker();
    expect(c.push("pi is 3.")).toEqual([]);
    expect(c.push("14 approx")).toEqual([]);   // "3." was never followed by whitespace
    expect(c.flush()).toBe("pi is 3.14 approx");
  });

  it("flush returns undefined on an empty buffer", () => {
    const c = new SentenceChunker();
    expect(c.flush()).toBeUndefined();
  });

  it("emits multiple sentences from one push", () => {
    const c = new SentenceChunker();
    expect(c.push("One. Two! Three? ")).toEqual(["One.", "Two!", "Three?"]);
    expect(c.flush()).toBeUndefined();
  });
});

function makeSup(scenarios: FakeStep[][], provider: "claude" | "codex" = "claude") {
  const dir = mkdtempSync(join(tmpdir(), `chimera-voice-tap-${provider}-`));
  const events = new EventLog(dir);
  let activeSessionId: string | undefined;
  const sup = new AgentSupervisor({
    registry: new AccountRegistry(provider === "codex" ? CODEX_CFG : CFG),
    credentials: new CredentialResolver(fakeExec, provider === "codex" ? codexEnv : undefined),
    backends: new Map([[provider, new FakeAgentBackend(scenarios, provider)]]),
    events,
    mailboxes: new MailboxStore(dir),
    cooldowns: new CooldownTracker(60_000),
    voiceActiveSession: () => (activeSessionId ? { sessionId: activeSessionId } : undefined),
  });
  return { sup, events, setSession: (id: string | undefined) => { activeSessionId = id; } };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

const STREAM: FakeStep[] = [
  { emit: { kind: "agent_started", data: {} } },
  { emit: { kind: "message_delta", data: { text: "Hello wor" } } },
  { emit: { kind: "message_delta", data: { text: "ld. How are you" } } },
  { emit: { kind: "message_delta", data: { text: "?" } } },
  { emit: { kind: "message_complete", data: { text: "Hello world. How are you?" } } },
  { end: { resultText: "done" } },
];

for (const provider of ["claude", "codex"] as const) {
  describe(`voice_tts_chunk tap (${provider})`, () => {
    it("emits sentence-chunked deltas + a final flush when a voice session is active", async () => {
      const { sup, events, setSession } = makeSup([[...STREAM]], provider);
      setSession("sess-1");
      const rec = await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
      await tick();

      const voiceEvents = events.tail(rec.agentId, 50).filter((e) => e.kind === "voice_tts_chunk");
      expect(voiceEvents.map((e) => e.data)).toEqual([
        { sessionId: "sess-1", text: "Hello world.", final: false },
        { sessionId: "sess-1", text: "How are you?", final: true },
      ]);
    });

    it("emits nothing when no voice session is active", async () => {
      const { sup, events } = makeSup([[...STREAM]], provider);
      const rec = await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
      await tick();

      const voiceEvents = events.tail(rec.agentId, 50).filter((e) => e.kind === "voice_tts_chunk");
      expect(voiceEvents).toEqual([]);
    });
  });
}

describe("voice_tts_chunk tap: turn_complete flush", () => {
  it("flushes a leftover buffer on turn_complete even with no trailing message_complete", async () => {
    const { sup, events, setSession } = makeSup([[
      { emit: { kind: "agent_started", data: {} } },
      { emit: { kind: "message_delta", data: { text: "no terminal punctuation" } } },
      { emit: { kind: "turn_complete", data: {} } },
      { end: { resultText: "done" } },
    ]]);
    setSession("sess-2");
    const rec = await sup.spawn({ prompt: "hi", cwd: "/tmp", isolation: "none" });
    await tick();

    const voiceEvents = events.tail(rec.agentId, 50).filter((e) => e.kind === "voice_tts_chunk");
    expect(voiceEvents.map((e) => e.data)).toEqual([
      { sessionId: "sess-2", text: "no terminal punctuation", final: true },
    ]);
  });
});
