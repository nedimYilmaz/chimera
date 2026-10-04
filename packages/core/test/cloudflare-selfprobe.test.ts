import { describe, it, expect } from "vitest";
import { selfprobeCloudflareTunnel, type ProbeFn } from "../src/cloudflare-selfprobe";

describe("selfprobeCloudflareTunnel", () => {
  it("passes only when WITH-token sees the banner and WITHOUT-token does not", async () => {
    const probe: ProbeFn = async ({ withToken }) => ({ sawSshBanner: withToken !== null });
    expect(
      await selfprobeCloudflareTunnel({ hostname: "a.example.com", clientId: "c", clientSecret: "s", probe }),
    ).toBe("passed");
  });

  it("THE LOAD-BEARING CASE: fails when the negative probe also sees the banner (edge gate leaked)", async () => {
    const probe: ProbeFn = async () => ({ sawSshBanner: true }); // both directions see it — Access gate is not enforcing
    expect(
      await selfprobeCloudflareTunnel({ hostname: "a.example.com", clientId: "c", clientSecret: "s", probe, retryWindowMs: 0 }),
    ).toBe("failed");
  });

  it("fails when the positive probe never sees a banner (retries exhaust the window)", async () => {
    const probe: ProbeFn = async () => ({ sawSshBanner: false });
    expect(
      await selfprobeCloudflareTunnel({ hostname: "a.example.com", clientId: "c", clientSecret: "s", probe, retryWindowMs: 0 }),
    ).toBe("failed");
  });

  it("a stale negative pass from an earlier round doesn't count once positive starts passing", async () => {
    let call = 0;
    // Round 1: positive fails, negative passes (correctly gated but not up yet).
    // Round 2: positive passes, negative ALSO passes this round (leak) -> must still fail.
    const probe: ProbeFn = async ({ withToken }) => {
      call++;
      if (call <= 2) return { sawSshBanner: withToken === null ? false : false }; // round 1: neither
      return { sawSshBanner: true }; // round 2: both see it
    };
    expect(
      await selfprobeCloudflareTunnel({
        hostname: "a.example.com",
        clientId: "c",
        clientSecret: "s",
        probe,
        retryWindowMs: 20,
        retryIntervalMs: 5,
      }),
    ).toBe("failed");
  });
});
