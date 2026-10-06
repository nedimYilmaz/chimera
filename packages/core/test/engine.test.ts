import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend, type FakeStep } from "@chimera/core/backends/fake";
import type { AgentBackend } from "@chimera/core/backend";
import { EventLog } from "@chimera/core/events";
import { AgentSupervisor } from "@chimera/core/supervisor";
import { PROTOCOL_VERSION } from "@chimera/protocol";
import { makeEngineHome } from "./helpers.js"; // defined in Task 8's helpers.ts

function engine(): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([])]]),
  });
}

function engineWithScenarios(scenarios: FakeStep[][]): Engine {
  return new Engine({
    home: makeEngineHome(),
    backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend(scenarios)]]),
  });
}

describe("Engine.handle", () => {
  const spawnBody = (over: Record<string, unknown> = {}) =>
    ({ spec: { prompt: "hello", cwd: "/tmp", isolation: "none", ...over } });

  it("spawns, waits, and returns the fake default result", async () => {
    const e = engine();
    const rec = (await e.handle("agent.spawn", { spec: { prompt: "hello", cwd: "/tmp", isolation: "none" } })) as { agentId: string };
    const final = (await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 })) as { state: string; resultText: string };
    expect(final.state).toBe("done");
    expect(final.resultText).toBe("fake:hello");
    const res = (await e.handle("agent.result", { agentId: rec.agentId })) as { text: string };
    expect(res.text).toBe("fake:hello");
  });

  it("reports status and accounts", async () => {
    const e = engine();
    expect(await e.handle("accounts.list", {})).toEqual([{ name: "main", provider: "claude", authType: "subscription", remoteControlCapable: true, hasKey: false }]);
    // accounts.test on a subscription account reports "ok" WITHOUT a key probe —
    // it has no API key (ambient CLI login), so the null-key probe would falsely
    // say auth_error and the UI would mark the main account "invalid".
    expect(await e.handle("accounts.test", { name: "main" })).toEqual({ name: "main", result: "ok" });
    const st = (await e.handle("daemon.status", {})) as { protocolVersion: number; engineId: string; agents: { running: number } };
    expect(st.protocolVersion).toBe(1);
    expect(st).toMatchObject({ engineId: "local" }); // federation pre-provision
  });

  it("maps errors to {code,message} shapes", async () => {
    const e = engine();
    await expect(e.handle("agent.status", { agentId: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("no.such.method", {})).rejects.toMatchObject({ code: "protocol" });
    await expect(e.handle("agent.spawn", { spec: { prompt: "" } })).rejects.toMatchObject({ code: "protocol" });
  });

  // ---------- additional coverage: every method, every branch/edge ----------

  describe("construction", () => {
    it("exposes readonly `events` and `supervisor` instances", () => {
      const e = engine();
      expect(e.events).toBeInstanceOf(EventLog);
      expect(e.supervisor).toBeInstanceOf(AgentSupervisor);
    });
  });

  describe("daemon.status", () => {
    it("reports protocolVersion pinned to @chimera/protocol's PROTOCOL_VERSION", async () => {
      const e = engine();
      const st = (await e.handle("daemon.status", {})) as { protocolVersion: number };
      expect(st.protocolVersion).toBe(PROTOCOL_VERSION);
    });

    it("reports zero counts when no agents have been spawned", async () => {
      const e = engine();
      const st = (await e.handle("daemon.status", {})) as { agents: Record<string, number> };
      expect(st.agents).toEqual({ running: 0, paused: 0, done: 0, failed: 0, killed: 0 });
    });

    it("counts agents across every state: running, done, failed, killed", async () => {
      const RUNNING: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "never" } }];
      const DONE: FakeStep[] = [{ end: { resultText: "done-one" } }];
      const FAILED: FakeStep[] = [{ fail: { message: "boom" } }];
      const KILLED: FakeStep[] = [{ awaitSend: true }, { end: { resultText: "never2" } }];
      const e = engineWithScenarios([RUNNING, DONE, FAILED, KILLED]);

      const running = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const done = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const failed = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const killed = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };

      await e.handle("agent.wait", { agentId: done.agentId, timeoutMs: 1000 });
      await e.handle("agent.wait", { agentId: failed.agentId, timeoutMs: 1000 });
      await e.handle("agent.kill", { agentId: killed.agentId });
      void running; // left running on purpose

      const st = (await e.handle("daemon.status", {})) as { agents: Record<string, number> };
      expect(st.agents).toEqual({ running: 1, paused: 0, done: 1, failed: 1, killed: 1 });
    });
  });

  describe("agent.spawn", () => {
    it("defaults depth to 0 when omitted", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { depth: number };
      expect(rec.depth).toBe(0);
    });

    it("forwards maxDepthCap to supervisor.spawn and allows depth exactly at the cap (boundary inclusive)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", {
        spec: { prompt: "x", cwd: "/tmp", isolation: "none", orchestration: { maxDepth: 10 } },
        depth: 1,
        maxDepthCap: 1,
      })) as { state: string };
      expect(rec.state).toBe("running");
    });

    it("maps a depth-exceeds-maxDepthCap guardrail rejection to {code:'guardrail'}", async () => {
      const e = engine();
      await expect(e.handle("agent.spawn", {
        spec: { prompt: "x", cwd: "/tmp", isolation: "none", orchestration: { maxDepth: 10 } },
        depth: 2,
        maxDepthCap: 1,
      })).rejects.toMatchObject({ code: "guardrail" });
    });

    it("rejects a negative depth (zod validation -> protocol)", async () => {
      const e = engine();
      await expect(e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp" }, depth: -1 }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects a non-positive maxDepthCap (zod validation -> protocol)", async () => {
      const e = engine();
      await expect(e.handle("agent.spawn", { spec: { prompt: "x", cwd: "/tmp" }, maxDepthCap: 0 }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects when 'spec' is entirely omitted from params", async () => {
      const e = engine();
      await expect(e.handle("agent.spawn", {})).rejects.toMatchObject({ code: "protocol" });
    });

    it("stamps an optional {team, role} membership so a no-queue project-run session carries it (coverage B12b)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", {
        spec: { prompt: "x", cwd: "/tmp", isolation: "none" },
        membership: { team: "alpha", role: "builder" },
      })) as { agentId: string };
      const list = (await e.handle("agent.list", {})) as Array<{ agentId: string; membership?: { team: string; role: string } }>;
      const row = list.find((r) => r.agentId === rec.agentId)!;
      expect(row.membership).toEqual({ team: "alpha", role: "builder" });
    });

    it("carries no membership when the field is omitted (plain agent.spawn stays byte-identical)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string; membership?: unknown };
      expect(rec.membership).toBeUndefined();
    });

    it("rejects a malformed membership (missing role -> protocol)", async () => {
      const e = engine();
      await expect(e.handle("agent.spawn", {
        spec: { prompt: "x", cwd: "/tmp", isolation: "none" },
        membership: { team: "alpha" },
      })).rejects.toMatchObject({ code: "protocol" });
    });
  });

  describe("agent.list", () => {
    it("returns every spawned agent record", async () => {
      const e = engine();
      const a = (await e.handle("agent.spawn", spawnBody({ prompt: "a" }))) as { agentId: string };
      const b = (await e.handle("agent.spawn", spawnBody({ prompt: "b" }))) as { agentId: string };
      const list = (await e.handle("agent.list", {})) as Array<{ agentId: string }>;
      expect(list.map((r) => r.agentId).sort()).toEqual([a.agentId, b.agentId].sort());
    });

    it("returns an empty array when nothing has been spawned", async () => {
      const e = engine();
      expect(await e.handle("agent.list", {})).toEqual([]);
    });
  });

  describe("agent.listSummary", () => {
    it("carries displayLabel when the agent was renamed, omits it otherwise", async () => {
      const e = engineWithScenarios([
        [{ awaitSend: true }, { end: { resultText: "x" } }],
        [{ awaitSend: true }, { end: { resultText: "x" } }],
      ]);
      const named = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const unnamed = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await e.handle("agent.rename", { agentId: named.agentId, displayLabel: "PROJ-1234 owner" });

      const list = (await e.handle("agent.listSummary", {})) as Array<{ id: string; displayLabel?: string }>;
      const namedRow = list.find((r) => r.id === named.agentId)!;
      const unnamedRow = list.find((r) => r.id === unnamed.agentId)!;
      expect(namedRow.displayLabel).toBe("PROJ-1234 owner");
      expect(unnamedRow.displayLabel).toBeUndefined();
    });
  });

  describe("agent.status", () => {
    it("returns the record for a known agent", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const status = (await e.handle("agent.status", { agentId: rec.agentId })) as { agentId: string; state: string };
      expect(status.agentId).toBe(rec.agentId);
      expect(status.state).toBe("running");
    });

    it("throws protocol for an unknown agent id", async () => {
      const e = engine();
      await expect(e.handle("agent.status", { agentId: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects a non-string agentId (zod validation -> protocol)", async () => {
      const e = engine();
      await expect(e.handle("agent.status", { agentId: 123 })).rejects.toMatchObject({ code: "protocol" });
    });
  });

  describe("agent.result", () => {
    it("reflects the running state before completion (text undefined, costUsd 0)", async () => {
      const e = engineWithScenarios([[{ awaitSend: true }, { end: { resultText: "later" } }]]);
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const res = (await e.handle("agent.result", { agentId: rec.agentId })) as { state: string; text?: string; costUsd: number };
      expect(res.state).toBe("running");
      expect(res.text).toBeUndefined();
      expect(res.costUsd).toBe(0);
    });

    it("returns text/costUsd after completion", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody({ prompt: "world" }))) as { agentId: string };
      await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });
      const res = (await e.handle("agent.result", { agentId: rec.agentId })) as { state: string; text: string };
      expect(res.state).toBe("done");
      expect(res.text).toBe("fake:world");
    });

    it("throws protocol for an unknown agent id", async () => {
      const e = engine();
      await expect(e.handle("agent.result", { agentId: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    });
  });

  describe("agent.wait", () => {
    it("applies the default timeoutMs (60000) when omitted", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const final = (await e.handle("agent.wait", { agentId: rec.agentId })) as { state: string };
      expect(final.state).toBe("done");
    });

    it("accepts timeoutMs at the exact max boundary (300000)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const final = (await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 300_000 })) as { state: string };
      expect(final.state).toBe("done");
    });

    it("rejects timeoutMs above the max boundary (300001) as a protocol error", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 300_001 }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects timeoutMs of 0 (must be positive)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 0 }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects a negative timeoutMs", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: -1 }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("throws protocol for an unknown agent id", async () => {
      const e = engine();
      await expect(e.handle("agent.wait", { agentId: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    });

    it("maps a plain Error without a .code property (a real waitFor timeout) to rpc code 'unknown'", async () => {
      const e = engineWithScenarios([[{ awaitSend: true }, { end: { resultText: "never" } }]]);
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 20 }))
        .rejects.toMatchObject({ code: "unknown" });
    });
  });

  describe("agent.send", () => {
    it("delivers a message and returns the ack evidence (F09)", async () => {
      const e = engineWithScenarios([[{ awaitSend: true }, { end: { resultText: "after send" } }]]);
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const res = await e.handle("agent.send", { agentId: rec.agentId, text: "go" });
      // F09: agent.send answers with evidence -- the bare {ok:true} widened into an ack result.
      expect(res).toEqual({ ok: true, delivered: true, turnStarted: true, ack: "started", ackMs: expect.any(Number), deliveryId: expect.any(String), stallThresholdMs: 45_000 });
      const final = (await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 })) as { state: string };
      expect(final.state).toBe("done");
    });

    it("defaults 'from' to 'caller' and forwards it to the agent (visible in the echoed event)", async () => {
      const e = engineWithScenarios([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await e.handle("agent.send", { agentId: rec.agentId, text: "hi" });
      await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });
      const tail = e.events.tail(rec.agentId, 50);
      const echoed = tail.find((ev) => ev.kind === "message_complete");
      expect(echoed?.data["text"]).toBe("echo:hi");
    });

    it("forwards an explicit 'from' when provided", async () => {
      const e = engineWithScenarios([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await e.handle("agent.send", { agentId: rec.agentId, text: "hi", from: "supervisor-42" });
      await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });
      const tail = e.events.tail(rec.agentId, 50);
      const echoed = tail.find((ev) => ev.kind === "message_complete");
      expect(echoed?.data["text"]).toBe("echo:hi");
    });

    it("preserves explicit force intent through RPC into the delivered message", async () => {
      const e = engineWithScenarios([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await e.handle("agent.send", { agentId: rec.agentId, text: "steer now", force: true });
      await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });
      const delivered = e.events.tail(rec.agentId, 50).find(ev => ev.kind === "status" && ev.data["delivered"]);
      expect(delivered?.data).toMatchObject({ text: "steer now", force: true });
    });

    it("rejects an empty text (zod min(1) -> protocol)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.send", { agentId: rec.agentId, text: "" }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("throws protocol for an unknown agent id", async () => {
      const e = engine();
      await expect(e.handle("agent.send", { agentId: "ghost", text: "hi" })).rejects.toMatchObject({ code: "protocol" });
    });

    it("throws protocol for a non-running (done) agent", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });
      await expect(e.handle("agent.send", { agentId: rec.agentId, text: "hi" })).rejects.toMatchObject({ code: "protocol" });
    });
  });

  // IMAGE.PASTE (TUI #7): SendParams gains an additive optional `images` array,
  // zod-validated to the same {mediaType (4-way enum), data (non-empty)} shape
  // as @chimera/core/backend's Image, forwarded to supervisor.send(...images).
  describe("agent.send: images (IMAGE.PASTE)", () => {
    const PNG = { mediaType: "image/png" as const, data: "aGVsbG8=" };

    it("parses a valid images array and forwards it into the persisted mailbox record", async () => {
      const home = makeEngineHome();
      const e = new Engine({
        home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "done" } }]])]]),
      });
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const res = await e.handle("agent.send", { agentId: rec.agentId, text: "look", images: [PNG] });
      expect(res).toMatchObject({ ok: true, delivered: true });
      const raw = readFileSync(join(home, "mailboxes", encodeURIComponent(rec.agentId) + ".jsonl"), "utf8");
      expect(JSON.parse(raw.trim())).toMatchObject({ message: { content: [{ type: "text", text: "look" }, { type: "image", ...PNG }] } });
    });

    it("accepts images: [] without error and omits it from the persisted record (normalized like absent)", async () => {
      const home = makeEngineHome();
      const e = new Engine({
        home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "done" } }]])]]),
      });
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await e.handle("agent.send", { agentId: rec.agentId, text: "look", images: [] });
      const raw = readFileSync(join(home, "mailboxes", encodeURIComponent(rec.agentId) + ".jsonl"), "utf8");
      expect(raw).not.toContain("images");
    });

    it("omits `images` entirely from the persisted record when the field itself is absent (backward compat)", async () => {
      const home = makeEngineHome();
      const e = new Engine({
        home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "done" } }]])]]),
      });
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await e.handle("agent.send", { agentId: rec.agentId, text: "look" });
      const raw = readFileSync(join(home, "mailboxes", encodeURIComponent(rec.agentId) + ".jsonl"), "utf8");
      expect(raw).not.toContain("images");
    });

    it("rejects an invalid mediaType enum value with a protocol error", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.send", { agentId: rec.agentId, text: "x", images: [{ mediaType: "image/svg", data: "abc" }] }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects an image with an empty `data` string (zod min(1))", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.send", { agentId: rec.agentId, text: "x", images: [{ mediaType: "image/png", data: "" }] }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects an image object missing the required `data` field", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.send", { agentId: rec.agentId, text: "x", images: [{ mediaType: "image/png" }] }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects a non-array `images` value", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.send", { agentId: rec.agentId, text: "x", images: "not-an-array" }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("accepts each of the four supported media types", async () => {
      const e = engineWithScenarios([[{ awaitSend: true }, { end: { resultText: "done" } }]]);
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const types = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
      const res = await e.handle("agent.send", {
        agentId: rec.agentId, text: "x", images: types.map((mediaType) => ({ mediaType, data: "d" })),
      });
      expect(res).toMatchObject({ ok: true, delivered: true });
    });
  });

  // D9 (F13 composer wire): SendParams gains an additive optional `content` array
  // (@chimera/protocol ContentBlockSchema) -- ordered text/image blocks that, when
  // present, let a caller interleave images at exact mid-sentence positions instead
  // of the legacy text-then-images bunching. `images`/`text`-only calls (above) stay
  // byte-for-byte unaffected.
  describe("agent.send: content[] blocks (D9)", () => {
    const CONTENT = [
      { type: "text" as const, text: "look at " },
      { type: "image" as const, mediaType: "image/png" as const, data: "AAA" },
      { type: "text" as const, text: " and " },
      { type: "image" as const, mediaType: "image/jpeg" as const, data: "BBB" },
    ];

    it("parses a valid content array and forwards it into the persisted mailbox record, in order", async () => {
      const home = makeEngineHome();
      const e = new Engine({
        home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "done" } }]])]]),
      });
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const res = await e.handle("agent.send", { agentId: rec.agentId, text: "look at [img] and [img]", content: CONTENT });
      expect(res).toMatchObject({ ok: true, delivered: true });
      const raw = readFileSync(join(home, "mailboxes", encodeURIComponent(rec.agentId) + ".jsonl"), "utf8");
      expect(JSON.parse(raw.trim())).toMatchObject({ message: { content: CONTENT } });
    });

    it("a legacy {text, images[]} call (no content field) is unaffected — omits `content` from the persisted record", async () => {
      const home = makeEngineHome();
      const e = new Engine({
        home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "done" } }]])]]),
      });
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const res = await e.handle("agent.send", { agentId: rec.agentId, text: "look", images: [{ mediaType: "image/png", data: "aGVsbG8=" }] });
      expect(res).toMatchObject({ ok: true, delivered: true });
      const raw = readFileSync(join(home, "mailboxes", encodeURIComponent(rec.agentId) + ".jsonl"), "utf8");
      expect(JSON.parse(raw)).not.toHaveProperty("content");
      expect(JSON.parse(raw.trim())).toMatchObject({ message: { content: [{ type: "text", text: "look" }, { type: "image", mediaType: "image/png", data: "aGVsbG8=" }] } });
    });

    it("accepts content: [] without error and omits it from the persisted record (normalized like absent)", async () => {
      const home = makeEngineHome();
      const e = new Engine({
        home, backends: new Map<string, AgentBackend>([["claude", new FakeAgentBackend([[{ awaitSend: true }, { end: { resultText: "done" } }]])]]),
      });
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await e.handle("agent.send", { agentId: rec.agentId, text: "look", content: [] });
      const raw = readFileSync(join(home, "mailboxes", encodeURIComponent(rec.agentId) + ".jsonl"), "utf8");
      expect(JSON.parse(raw)).not.toHaveProperty("content");
    });

    it("rejects a content block with an unknown `type`", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.send", { agentId: rec.agentId, text: "x", content: [{ type: "video", data: "abc" }] }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects a text content block with empty `text` (zod min(1))", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.send", { agentId: rec.agentId, text: "x", content: [{ type: "text", text: "" }] }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects an image content block with an invalid mediaType enum value", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.send", { agentId: rec.agentId, text: "x", content: [{ type: "image", mediaType: "image/svg", data: "abc" }] }))
        .rejects.toMatchObject({ code: "protocol" });
    });
  });

  describe("agent.kill", () => {
    it("stops a running agent and reports that it actually killed one", async () => {
      const e = engineWithScenarios([[{ awaitSend: true }, { end: { resultText: "never" } }]]);
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const res = await e.handle("agent.kill", { agentId: rec.agentId });
      expect(res).toEqual({ ok: true, killed: true, state: "killed" });
      const status = (await e.handle("agent.status", { agentId: rec.agentId })) as { state: string };
      expect(status.state).toBe("killed");
    });

    it("throws protocol for an unknown agent id", async () => {
      const e = engine();
      await expect(e.handle("agent.kill", { agentId: "ghost" })).rejects.toMatchObject({ code: "protocol" });
    });

    // KILL-REPORTS-TRUTHFULLY: this used to assert a bare {ok:true} for a no-op, which is
    // exactly what made an already-finished row look unkillable — the operator clicked kill,
    // the call reported success, and nothing moved. The answer now distinguishes "killed it"
    // from "there was nothing to kill", so a caller can say which happened.
    it("is a no-op on an already-done agent, and SAYS so rather than reporting a bare success", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });
      const res = await e.handle("agent.kill", { agentId: rec.agentId });
      expect(res).toEqual({ ok: true, killed: false, state: "done" });
      const status = (await e.handle("agent.status", { agentId: rec.agentId })) as { state: string };
      expect(status.state).toBe("done");
    });
  });

  describe("agent.tail", () => {
    it("defaults n to 50 and returns all events when agentId is omitted", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });
      const tail = (await e.handle("agent.tail", {})) as Array<{ agentId: string }>;
      expect(tail.length).toBeGreaterThan(0);
      expect(tail.every((ev) => ev.agentId === rec.agentId)).toBe(true);
    });

    it("filters by agentId when provided", async () => {
      const e = engine();
      const a = (await e.handle("agent.spawn", spawnBody({ prompt: "a" }))) as { agentId: string };
      const b = (await e.handle("agent.spawn", spawnBody({ prompt: "b" }))) as { agentId: string };
      await e.handle("agent.wait", { agentId: a.agentId, timeoutMs: 1000 });
      await e.handle("agent.wait", { agentId: b.agentId, timeoutMs: 1000 });
      const tailA = (await e.handle("agent.tail", { agentId: a.agentId })) as Array<{ agentId: string }>;
      expect(tailA.length).toBeGreaterThan(0);
      expect(tailA.every((ev) => ev.agentId === a.agentId)).toBe(true);
    });

    it("returns an empty array for an agentId with no events", async () => {
      const e = engine();
      const tail = await e.handle("agent.tail", { agentId: "ghost" });
      expect(tail).toEqual([]);
    });

    it("respects a custom n smaller than the available event count", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 });
      const full = (await e.handle("agent.tail", { agentId: rec.agentId, n: 50 })) as unknown[];
      const limited = (await e.handle("agent.tail", { agentId: rec.agentId, n: 1 })) as unknown[];
      expect(full.length).toBeGreaterThan(1);
      expect(limited.length).toBe(1);
    });

    it("rejects n=0 (must be positive)", async () => {
      const e = engine();
      await expect(e.handle("agent.tail", { n: 0 })).rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects a negative n", async () => {
      const e = engine();
      await expect(e.handle("agent.tail", { n: -5 })).rejects.toMatchObject({ code: "protocol" });
    });
  });

  describe("agent.permissionRespond", () => {
    it("resolves a pending poke:caller decision and returns {handled:true}", async () => {
      const ASK: FakeStep[] = [{ askPermission: { toolName: "Bash" } }, { end: { resultText: "done" } }];
      const e = engineWithScenarios([ASK]);
      let respondPromise: Promise<unknown> | undefined;
      const unsub = e.events.subscribe((ev) => {
        if (ev.kind === "permission_request") {
          respondPromise = e.handle("agent.permissionRespond", { requestId: String(ev.data["requestId"]), allow: true });
        }
      });
      const rec = (await e.handle("agent.spawn", {
        spec: { prompt: "x", cwd: "/tmp", isolation: "none", on: { permissionRequest: "poke:caller" } },
      })) as { agentId: string };
      const final = (await e.handle("agent.wait", { agentId: rec.agentId, timeoutMs: 1000 })) as { state: string };
      unsub();
      expect(final.state).toBe("done");
      await expect(respondPromise).resolves.toEqual({ handled: true });
      const tail = e.events.tail(rec.agentId, 50);
      expect(tail.some((ev) => ev.kind === "tool_call")).toBe(true); // Bash was allowed
    });

    it("returns {handled:false} for an unknown/expired requestId", async () => {
      const e = engine();
      const res = await e.handle("agent.permissionRespond", { requestId: "nope", allow: true });
      expect(res).toEqual({ handled: false });
    });

    it("rejects params missing 'allow' (zod validation -> protocol)", async () => {
      const e = engine();
      await expect(e.handle("agent.permissionRespond", { requestId: "x" })).rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects a non-string requestId (zod validation -> protocol)", async () => {
      const e = engine();
      await expect(e.handle("agent.permissionRespond", { requestId: 123, allow: true })).rejects.toMatchObject({ code: "protocol" });
    });
  });

  // TUI backlog 8b: dynamic (live) permission change for a RUNNING agent.
  describe("agent.setPermission", () => {
    it("forwards params to supervisor.setPermission and returns {ok:true, appliedToRunningProcess}", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", {
        spec: { prompt: "x", cwd: "/tmp", isolation: "none", permissionProfile: "acceptEdits", on: { permissionRequest: "tui" } },
      })) as { agentId: string };

      const res = await e.handle("agent.setPermission", {
        agentId: rec.agentId, permissionRequest: "auto", permissionProfile: "full",
      });
      // CODEX-SETPERMISSION-IS-COSMETIC-TO-THE-OPERATOR: a claude agent's live change genuinely
      // applies, so the RPC caller sees appliedToRunningProcess:true here (codex case covered in
      // supervisor-permission.test.ts, closer to the source of the distinction).
      expect(res).toEqual({ ok: true, appliedToRunningProcess: true });

      const status = e.supervisor.status(rec.agentId);
      expect(status.spec.on.permissionRequest).toBe("auto");
      expect(status.spec.permissionProfile).toBe("full");
    });

    it("rejects an unknown agentId (protocol error, via supervisor.status guard)", async () => {
      const e = engine();
      await expect(e.handle("agent.setPermission", { agentId: "ghost", permissionRequest: "auto" }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects an invalid permissionRequest enum value (zod validation -> protocol)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.setPermission", { agentId: rec.agentId, permissionRequest: "bogus" }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects an invalid permissionProfile enum value (zod validation -> protocol)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.setPermission", { agentId: rec.agentId, permissionProfile: "bogus" }))
        .rejects.toMatchObject({ code: "protocol" });
    });
  });

  describe("agent.ask / agent.answerQuestion (spec §17)", () => {
    it("agent.ask blocks then resolves when agent.answerQuestion arrives", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      // answer as soon as the agent_question event is observed
      e.events.subscribe((ev) => {
        if (ev.kind === "agent_question") {
          void e.handle("agent.answerQuestion", { questionId: ev.data["questionId"], answer: { optionIds: ["go"] } });
        }
      });
      const res = (await e.handle("agent.ask", {
        agentId: rec.agentId, prompt: "ship?",
        options: [{ id: "go", label: "Go" }, { id: "stop", label: "Stop" }],
      })) as { questionId: string; answer: unknown };
      expect(typeof res.questionId).toBe("string");
      expect(res.answer).toEqual({ optionIds: ["go"] });
    });

    it("agent.answerQuestion returns {handled:false} for an unknown questionId", async () => {
      const e = engine();
      expect(await e.handle("agent.answerQuestion", { questionId: "nope", answer: { text: "x" } }))
        .toEqual({ handled: false });
    });

    it("agent.ask rejects a ghost agent with a protocol error", async () => {
      const e = engine();
      await expect(e.handle("agent.ask", { agentId: "ghost", prompt: "?" })).rejects.toMatchObject({ code: "protocol" });
    });

    it("agent.ask rejects an empty prompt with a protocol error", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.ask", { agentId: rec.agentId, prompt: "" })).rejects.toMatchObject({ code: "protocol" });
    });

    // ---------- additional coverage: every branch/edge in AskParams/AnswerParams ----------

    it("accepts a header longer than 12 characters (no length cap enforced at the Engine layer)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      e.events.subscribe((ev) => {
        if (ev.kind === "agent_question") {
          void e.handle("agent.answerQuestion", { questionId: ev.data["questionId"], answer: { text: "ok" } });
        }
      });
      const res = (await e.handle("agent.ask", {
        agentId: rec.agentId, prompt: "confirm?", header: "This header is way over twelve characters",
      })) as { answer: unknown };
      expect(res.answer).toEqual({ text: "ok" });
    });

    it("accepts an explicit default:null and an explicit timeoutMs:null without validation errors", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      e.events.subscribe((ev) => {
        if (ev.kind === "agent_question") {
          void e.handle("agent.answerQuestion", { questionId: ev.data["questionId"], answer: { text: "ok" } });
        }
      });
      const res = (await e.handle("agent.ask", {
        agentId: rec.agentId, prompt: "p", default: null, timeoutMs: null,
      })) as { answer: unknown };
      expect(res.answer).toEqual({ text: "ok" });
    });

    it("rejects timeoutMs of 0 (must be positive)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.ask", { agentId: rec.agentId, prompt: "p", timeoutMs: 0 }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects a negative timeoutMs", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.ask", { agentId: rec.agentId, prompt: "p", timeoutMs: -1 }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects a malformed option missing a required 'label' (zod validation -> protocol)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.ask", { agentId: rec.agentId, prompt: "p", options: [{ id: "a" }] }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("rejects when 'agentId' is omitted from agent.ask params", async () => {
      const e = engine();
      await expect(e.handle("agent.ask", { prompt: "p" })).rejects.toMatchObject({ code: "protocol" });
    });

    it("agent.answerQuestion rejects a malformed answer payload (unknown extra field, strict schema)", async () => {
      const e = engine();
      await expect(e.handle("agent.answerQuestion", { questionId: "x", answer: { text: "x", bogus: true } }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("agent.answerQuestion rejects params missing 'answer'", async () => {
      const e = engine();
      await expect(e.handle("agent.answerQuestion", { questionId: "x" })).rejects.toMatchObject({ code: "protocol" });
    });

    // ---------- Task D1: agent->agent `to` (single peer) ----------

    it("agent.ask with `to` delivers the question to the target's mailbox and the target's answer_question resolves the asker", async () => {
      const e = engineWithScenarios([
        [{ awaitSend: true }, { end: { resultText: "a-done" } }],
        [{ awaitSend: true }, { end: { resultText: "b-done" } }],
      ]);
      const a = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const b = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      let questionId = "";
      e.events.subscribe((ev) => {
        if (ev.kind === "agent_question" && ev.agentId === a.agentId) questionId = String(ev.data["questionId"]);
      });
      const delivered = new Promise<string>((resolve) => {
        e.events.subscribe((ev) => {
          if (ev.agentId === b.agentId && ev.kind === "message_complete") resolve(String(ev.data["text"]));
        });
      });
      const askPromise = e.handle("agent.ask", { agentId: a.agentId, prompt: "pick", to: { agentId: b.agentId } });
      const deliveredText = await delivered;
      expect(deliveredText).toContain(`[question ${questionId} from ${a.agentId}]`);
      await e.handle("agent.answerQuestion", { questionId, answer: { text: "blue" } });
      const res = (await askPromise) as { questionId: string; answer: unknown };
      expect(res.answer).toEqual({ text: "blue" });
    });

    it("agent.ask event data carries to/replyTo when `to` is set", async () => {
      expect.assertions(2);
      const e = engineWithScenarios([
        [{ awaitSend: true }, { end: { resultText: "a-done" } }],
        [{ awaitSend: true }, { end: { resultText: "b-done" } }],
      ]);
      const a = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      const b = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      e.events.subscribe((ev) => {
        if (ev.kind === "agent_question" && ev.agentId === a.agentId) {
          expect(ev.data["to"]).toBe(b.agentId);
          expect(ev.data["replyTo"]).toBe(a.agentId);
          void e.handle("agent.answerQuestion", { questionId: ev.data["questionId"], answer: { text: "x" } });
        }
      });
      await e.handle("agent.ask", { agentId: a.agentId, prompt: "p", to: { agentId: b.agentId } });
    });

    it("agent.ask rejects a `to` object with an unknown extra field (strict schema)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.ask", { agentId: rec.agentId, prompt: "p", to: { agentId: rec.agentId, bogus: true } }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("agent.ask rejects a `to.agentId` empty string (min(1))", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.ask", { agentId: rec.agentId, prompt: "p", to: { agentId: "" } }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("agent.ask with `to` targeting an unknown agent rejects with a protocol error (UnknownAgentError propagates)", async () => {
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      await expect(e.handle("agent.ask", { agentId: rec.agentId, prompt: "p", to: { agentId: "ghost" } }))
        .rejects.toMatchObject({ code: "protocol" });
    });

    it("agent.ask without `to` stays byte-identical: no to/replyTo keys on the event", async () => {
      expect.assertions(2);
      const e = engine();
      const rec = (await e.handle("agent.spawn", spawnBody())) as { agentId: string };
      e.events.subscribe((ev) => {
        if (ev.kind === "agent_question") {
          expect("to" in ev.data).toBe(false);
          expect("replyTo" in ev.data).toBe(false);
          void e.handle("agent.answerQuestion", { questionId: ev.data["questionId"], answer: { text: "ok" } });
        }
      });
      await e.handle("agent.ask", { agentId: rec.agentId, prompt: "p" });
    });
  });

  describe("error mapping", () => {
    it("maps an unknown RPC method to a protocol error naming the method", async () => {
      const e = engine();
      await expect(e.handle("no.such.method", {})).rejects.toMatchObject({
        code: "protocol",
        message: expect.stringContaining("no.such.method"),
      });
    });

    it("maps a ZodError (malformed params) to protocol with a non-empty message", async () => {
      const e = engine();
      const caught = await e.handle("agent.status", { agentId: 123 }).catch((err: unknown) => err);
      expect(caught).toMatchObject({ code: "protocol" });
      expect((caught as { message: string }).message).toEqual(expect.any(String));
      expect((caught as { message: string }).message.length).toBeGreaterThan(0);
    });
  });
});
