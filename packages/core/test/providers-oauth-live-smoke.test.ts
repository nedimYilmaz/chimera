// F23-2A (D7 verification policy): live-smoke tests that SKIP unless real credentials exist —
// never run against the real network/CLI in CI. Copilot has no way to smoke-test without a
// human completing a device flow interactively, so its "live" coverage is the unit suite in
// providers-oauth-flows.test.ts. Grok Build's story is different: if the official Grok CLI is
// installed and logged in on THIS machine, ~/.grok/auth.json already exists — so this test can
// actually read it and confirm GrokCliOAuthFlow resolves a real token end to end.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrokCliOAuthFlow } from "@chimera/core/providers/oauth-flows";
import { PendingOAuthStore } from "@chimera/core/providers/pending-oauth";

const GROK_AUTH_PATH = join(homedir(), ".grok", "auth.json");
const hasGrokCreds = existsSync(GROK_AUTH_PATH);

describe.skipIf(!hasGrokCreds)("F23-2A live-smoke: Grok Build CLI credentials", () => {
  it("GrokCliOAuthFlow resolves a real token from the installed Grok CLI's auth.json", async () => {
    const raw = JSON.parse(readFileSync(GROK_AUTH_PATH, "utf8")) as { access_token?: string };
    expect(raw.access_token, "auth.json present but missing access_token — log in again via the Grok CLI").toBeTruthy();

    const flow = new GrokCliOAuthFlow();   // default path — no injected seam, the real file
    const pending = new PendingOAuthStore();
    const { id } = pending.create("grok-build");
    const result = await flow.start(pending, id);
    expect(result).toEqual({ kind: "immediate" });
    expect(pending.get(id)?.state.status).toBe("ready");
  });
});

if (!hasGrokCreds) {
  describe("F23-2A live-smoke: Grok Build CLI credentials", () => {
    it.skip(`skipped — no ~/.grok/auth.json on this machine (${GROK_AUTH_PATH})`, () => {});
  });
}
