import { afterAll, describe, expect, it } from "vitest";
import { ChimeraClient } from "@chimera/client";
import type { ChronicleExportResponse, ChronicleSearchResponse, NormalizedEvent } from "@chimera/protocol";
import { makeMultiProviderHome } from "../../core/test/helpers.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

const home = makeMultiProviderHome();
const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" };
let client: ChimeraClient | null = null;

afterAll(async () => {
  await client?.request("daemon.stop").catch(() => {});
  client?.close();
});

describe("Chronicle search survives a full daemon boot", () => {
  it("searches fake-backend transcript results through the real RPC after restart", async () => {
    client = await ChimeraClient.connect({ home, env });
    const a = await client.request<{ agentId: string }>("agent.spawn", { spec: { prompt: "chronicle alpha decision", cwd: "/tmp", isolation: "none" } });
    const b = await client.request<{ agentId: string }>("agent.spawn", { spec: { prompt: "chronicle beta followup", cwd: "/tmp", isolation: "none" } });
    await client.request("agent.wait", { agentId: a.agentId, timeoutMs: 5000 });
    await client.request("agent.wait", { agentId: b.agentId, timeoutMs: 5000 });
    await client.request("daemon.stop").catch(() => {}); // process may close the socket before the response flushes
    client.close(); client = null;
    const deadline = Date.now() + 5000;
    while ((existsSync(join(home, "daemon.sock")) || existsSync(join(home, "daemon.pid"))) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    client = await ChimeraClient.connect({ home, env });
    const found = await client.request<ChronicleSearchResponse>("events.search", { query: "chronicle alpha decision", limit: 1 });
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0]).toMatchObject({ agentId: a.agentId, kind: "result", fields: ["transcript"] });
    expect(found.retained.firstSeq).toBe(1);
    const replay = await client.request<NormalizedEvent[]>("events.replay", { fromSeq: 1, toSeq: found.hits[0]!.seq, limit: 500 });
    expect(replay.at(-1)?.seq).toBe(found.hits[0]!.seq);
    expect(replay.some((event) => event.agentId === b.agentId && event.seq > found.hits[0]!.seq)).toBe(false);
    const exported = await client.request<ChronicleExportResponse>("events.searchExport", { query: "chronicle", limit: 10, maxResults: 10 });
    expect(exported.content).toContain("chronicle alpha decision");
    expect(exported.content).toContain("chronicle beta followup");
  }, 20_000);
});
