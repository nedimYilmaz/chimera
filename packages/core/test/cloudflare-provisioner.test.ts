import { describe, expect, it } from "vitest";
import { CloudflareProvisioner } from "../src/cloudflare";

function fakeKeychain() {
  const store = new Map<string, string>();
  return {
    get: async (s: string) => store.get(s) ?? null,
    set: async (s: string, v: string) => void store.set(s, v),
    delete: async (s: string) => void store.delete(s),
    store,
  };
}

function fakeFetch(routes: Record<string, () => { status: number; body: unknown }>) {
  const calls: string[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    calls.push(key);
    const route = routes[key];
    if (!route) throw new Error(`unmocked fetch: ${key}`);
    const { status, body } = route();
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}

describe("CloudflareProvisioner.provision", () => {
  it("fails at verify-token, naming the missing scope, before touching anything else", async () => {
    const { fn, calls } = fakeFetch({
      "GET https://api.cloudflare.com/client/v4/user/tokens/verify": () => ({
        status: 403,
        body: { success: false, errors: [{ message: "missing scope: Tunnel:Edit" }] },
      }),
    });
    const kc = fakeKeychain();
    const prov = new CloudflareProvisioner({ engineId: "studio", keychain: kc, fetchFn: fn });
    const res = await prov.provision({ apiToken: "tok", domain: "example.com" });
    expect(res.steps[0]).toEqual({ step: "verify-token", ok: false, error: expect.stringContaining("Tunnel:Edit") });
    expect(res.steps.length).toBe(1); // stops before resolve-zone
    expect(calls.length).toBe(1);
  });

  it("a re-run after a failure at step k performs no duplicate creates", async () => {
    const engineId = "studio";
    const domain = "example.com";
    const accountId = "acct1";
    let tunnelCreated = 0;
    let ingressCalls = 0;
    let ingressShouldFail = true;

    const routes: Record<string, () => { status: number; body: unknown }> = {
      "GET https://api.cloudflare.com/client/v4/user/tokens/verify": () => ({
        status: 200,
        body: { success: true, result: { status: "active" } },
      }),
      "GET https://api.cloudflare.com/client/v4/accounts": () => ({
        status: 200,
        body: { success: true, result: [{ id: accountId }] },
      }),
      "GET https://api.cloudflare.com/client/v4/zones?name=example.com": () => ({
        status: 200,
        body: { success: true, result: [{ id: "zone1" }] },
      }),
      [`GET https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel?name=chimera-${engineId}`]: () => ({
        status: 200,
        body: { success: true, result: tunnelCreated > 0 ? [{ id: "tunnel1" }] : [] },
      }),
      [`POST https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel`]: () => {
        tunnelCreated++;
        return { status: 200, body: { success: true, result: { id: "tunnel1" } } };
      },
      "GET https://api.cloudflare.com/client/v4/accounts/acct1/cfd_tunnel/tunnel1/token": () => ({
        status: 200,
        body: { success: true, result: "tunnel-token-value" },
      }),
      "PUT https://api.cloudflare.com/client/v4/accounts/acct1/cfd_tunnel/tunnel1/configurations": () => {
        ingressCalls++;
        if (ingressShouldFail) return { status: 500, body: { success: false, errors: [{ message: "ingress failed" }] } };
        return { status: 200, body: { success: true, result: {} } };
      },
    };

    const kc = fakeKeychain();
    const { fn: fn1 } = fakeFetch(routes);
    const prov1 = new CloudflareProvisioner({ engineId, keychain: kc, fetchFn: fn1 });
    const res1 = await prov1.provision({ apiToken: "tok", domain });
    expect(res1.steps.some((s) => s.step === "set-ingress" && !s.ok)).toBe(true);
    expect(tunnelCreated).toBe(1);

    ingressShouldFail = false;
    const { fn: fn2 } = fakeFetch(routes);
    const prov2 = new CloudflareProvisioner({ engineId, keychain: kc, fetchFn: fn2 });
    await prov2.provision({ apiToken: "tok", domain });

    // create-tunnel POST fires exactly once across both calls; the GET-lookup fires on both.
    expect(tunnelCreated).toBe(1);
    expect(ingressCalls).toBe(2);
  });
});
