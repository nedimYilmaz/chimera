import { afterAll, describe, expect, it } from "vitest";
import { ChimeraClient } from "@chimera/client";
import type { ReviewFinding, ReviewSession } from "@chimera/protocol";
import { makeMultiProviderHome } from "../../core/test/helpers.js";
const home = makeMultiProviderHome(); const env = { ...process.env, CHIMERA_HOME: home, CHIMERA_BACKEND: "fake" }; let client: ChimeraClient | null = null;
afterAll(async () => { await client?.request("daemon.stop").catch(() => {}); client?.close(); });
describe("review room survives a full daemon boot", () => {
  it("records threaded findings and a decision through external RPCs", async () => {
    client = await ChimeraClient.connect({ home, env });
    const parent = await client.request<ReviewFinding>("review.finding.add", { taskId: "t1", path: "src/a.ts", hunkId: "h1", severity: "blocking", body: "incorrect" });
    await client.request("review.finding.add", { taskId: "t1", path: "src/a.ts", hunkId: "h1", parentId: parent.id, severity: "note", body: "acknowledged" });
    const decided = await client.request<ReviewSession>("review.decide", { taskId: "t1", status: "changes_requested", summary: "fix the blocker" });
    expect(decided.findings).toHaveLength(2); expect(decided.decision?.status).toBe("changes_requested");
    expect(await client.request<ReviewSession>("review.get", { taskId: "t1" })).toEqual(decided);
  }, 20_000);
});
