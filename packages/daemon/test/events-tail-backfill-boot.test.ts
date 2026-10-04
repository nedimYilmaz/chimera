import { afterAll, describe, expect, it } from "vitest";
import { ChimeraClient } from "@chimera/client";
import type { ChronicleSearchResponse, NormalizedEvent } from "@chimera/protocol";
import { makeMultiProviderHome } from "../../core/test/helpers.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

// FEATURE (Events tab lazy-loads recent past events on connect): the deterministic
// full-boot blackbox for that fix — mirrors chronicle-search-boot.test.ts's shape
// (real daemon over a real socket, CHIMERA_BACKEND=fake, a restart, then a FRESH
// client — simulating the app opening its Events tab with zero live history).
//
// Assertions are deliberately independent of the log's absolute/relative seq
// offset: a fresh CHIMERA_HOME can carry a handful of its own boot/reattach
// events around a restart (observed to vary under parallel test-file
// execution), so every check below either filters by our own agent ids (immune
// to unrelated noise) or compares two RPC responses against each other rather
// than against a predicted literal seq.
const home = makeMultiProviderHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };
let client: ChimeraClient | null = null;

afterAll(async () => {
  await client?.request("daemon.stop").catch(() => {});
  client?.close();
});

describe("Events tab tail-backfill survives a full daemon boot", () => {
  it("events.replay with no fromSeq returns the true recent tail (not the oldest page), and events.search still finds an older event, after a restart", async () => {
    client = await ChimeraClient.connect({ home, env });

    // FakeAgentBackend (scenarios always [] in the daemon, main.ts) falls back to a
    // fixed 3-event script per spawn — agent_started, turn_complete, result — with
    // no await between them, so spawning+waiting one agent fully before the next
    // gives a hard per-agent seq order: a's 3 events all precede b's, b's all
    // precede c's.
    const spawnAndWait = async (prompt: string): Promise<string> => {
      const { agentId } = await client!.request<{ agentId: string }>(
        "agent.spawn", { spec: { prompt, cwd: "/tmp", isolation: "none" } },
      );
      await client!.request("agent.wait", { agentId, timeoutMs: 5000 });
      return agentId;
    };

    const a = await spawnAndWait("tail-backfill alpha marker");
    await spawnAndWait("tail-backfill beta marker");
    const c = await spawnAndWait("tail-backfill gamma marker");

    await client.request("daemon.stop").catch(() => {}); // process may close the socket before the response flushes
    client.close(); client = null;
    const deadline = Date.now() + 5000;
    while ((existsSync(join(home, "daemon.sock")) || existsSync(join(home, "daemon.pid"))) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // A brand-new client with no live subscription history at all — exactly the
    // shape the app's EventsScreen.fetchSeed sees on a fresh connect.
    client = await ChimeraClient.connect({ home, env });

    // Per-agent filtered replay is immune to any unrelated events elsewhere in the
    // log — this is the precise, offset-independent ground truth for a's and c's
    // own 3-event scripts.
    const aOwn = await client.request<NormalizedEvent[]>("events.replay", { agentId: a, limit: 10 });
    const cOwn = await client.request<NormalizedEvent[]>("events.replay", { agentId: c, limit: 10 });
    // The leading `status` is chimera's own registration marker (supervisor's
    // AGENT-IDENTITY-INVISIBLE-IN-APP event, carrying account/provider/permission so a client
    // can render an agent that never emits anything else) — it precedes the fake backend's
    // 3-event script rather than being part of it.
    expect(aOwn.map((e) => e.kind)).toEqual(["status", "agent_started", "turn_complete", "result"]);
    expect(cOwn.map((e) => e.kind)).toEqual(["status", "agent_started", "turn_complete", "result"]);
    // Located by KIND, not by index: every assertion below is about "the result event", and an
    // index is only a proxy for that — a proxy this test already paid for once, when a new
    // leading event shifted every position by one.
    const aResult = aOwn.find((e) => e.kind === "result")!;
    const cResult = cOwn.find((e) => e.kind === "result")!;
    expect(cResult).toMatchObject({ kind: "result", data: { text: "fake:tail-backfill gamma marker" } });

    // The global tail (no fromSeq — omitted means "newest N", see EventLog.replay) must reach
    // back to c's own result. c's block is NOT the end of the log: main.ts ensures the daemon's
    // own MAIN conductor seat on every boot (FEATURE MAIN-CONDUCTOR-PERSISTENT), so the
    // post-restart boot's conductor block trails c's — which is why the window
    // has to be wider than c's block, and why it is written as a window rather than an offset.
    // Kept generous on purpose: this file's own header warns that boot/reattach noise around a
    // restart varies, and a snug window turns that variance into a flake.
    const WINDOW = 10;
    const tail = await client.request<NormalizedEvent[]>("events.replay", { limit: WINDOW });
    expect(tail.length).toBe(WINDOW);
    for (let i = 1; i < tail.length; i++) expect(tail[i]!.seq).toBeGreaterThan(tail[i - 1]!.seq);
    expect(tail.some((e) => e.seq === cResult.seq)).toBe(true);

    // Disambiguate from "an omitted fromSeq silently means fromSeq=1": the SAME-SIZE oldest page
    // must NOT contain c's late result — same window, opposite anchor, so the pair can only be
    // explained by the omitted-fromSeq call being genuinely tail-anchored.
    const head = await client.request<NormalizedEvent[]>("events.replay", { fromSeq: 1, limit: WINDOW });
    expect(head.some((e) => e.seq === cResult.seq)).toBe(false);

    // events.search still finds a's (much older) result — the persisted log,
    // independent of any live/ring/tail-window concept, is what the app's
    // EventsScreen search path relies on.
    const found = await client.request<ChronicleSearchResponse>("events.search", { query: "tail-backfill alpha marker", limit: 1 });
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0]).toMatchObject({ agentId: a, kind: "result", fields: ["transcript"], seq: aResult.seq });
    expect(found.hits[0]!.seq).toBeLessThan(cOwn[0]!.seq); // strictly precedes c's entire block
  }, 20_000);
});
