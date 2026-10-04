import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "@chimera/core/engine";
import { FakeAgentBackend } from "@chimera/core/backends/fake";
import { InMemoryKeychain } from "@chimera/core/keychain";
import type { ProbeFn } from "@chimera/core/cloudflare-selfprobe";
import type { CfFetchFn } from "@chimera/core/cloudflare";
import type { NetExecFn } from "@chimera/core/network";

// §13 addendum: once selfEndpoint() carries cloudflareAccess, fed.invite.create mints an
// ephemeral ssh-layer keypair via the SAME ssh-keygen exec seam fed.sshkey.ensure uses — fake it
// here too so no real ssh-keygen subprocess ever runs, and stub readHostKeys so /etc/ssh is
// never touched under test.
function fakeEd25519PubKey(): string {
  const typeStr = Buffer.from("ssh-ed25519", "ascii");
  const lp = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  const blob = Buffer.concat([lp(typeStr), lp(Buffer.alloc(32, 9))]).toString("base64");
  return `ssh-ed25519 ${blob} someone@host`;
}
const fakeSshKeygenExec: NetExecFn = async (cmd, args) => {
  if (cmd === "ssh-keygen") {
    const f = args[args.indexOf("-f") + 1]!;
    writeFileSync(f, "PRIVATE", { mode: 0o600 });
    writeFileSync(`${f}.pub`, `${fakeEd25519PubKey()}\n`);
    return { stdout: "", stderr: "", code: 0 };
  }
  return { stdout: "", stderr: "", code: 0 };
};

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chm-cf-eng-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    accounts: [{ name: "main", provider: "claude", auth: { type: "subscription" } }],
    autoOrder: ["main"],
    engine: { id: "studio" },
  }));
  return home;
}

function fakeCfFetch(accountId = "acct1", tunnelId = "tunnel1"): CfFetchFn {
  return (async (url: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const ok = (body: unknown) => new Response(JSON.stringify({ success: true, result: body }), { status: 200 });
    if (key === "GET https://api.cloudflare.com/client/v4/user/tokens/verify") return ok({ status: "active" });
    if (key === "GET https://api.cloudflare.com/client/v4/accounts") return ok([{ id: accountId }]);
    if (key === "GET https://api.cloudflare.com/client/v4/zones?name=example.com") return ok([{ id: "zone1" }]);
    if (key === `GET https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel?name=chimera-studio`) return ok([]);
    if (key === `POST https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel`) return ok({ id: tunnelId });
    if (key === `GET https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`) return ok("tunnel-token-value");
    if (key === `PUT https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`) return ok({});
    if (key === "GET https://api.cloudflare.com/client/v4/zones/zone1/dns_records?name=studio.example.com") return ok([]);
    if (key === "POST https://api.cloudflare.com/client/v4/zones/zone1/dns_records") return ok({});
    if (key === `GET https://api.cloudflare.com/client/v4/accounts/${accountId}/access/service_tokens`) return ok([]);
    if (key === `POST https://api.cloudflare.com/client/v4/accounts/${accountId}/access/service_tokens`)
      return ok({ client_id: "cid-1", client_secret: "secret-xyz" });
    if (key === `GET https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps`) return ok([]);
    if (key === `POST https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps`) return ok({ id: "app1" });
    throw new Error(`unmocked fetch: ${key}`);
  }) as CfFetchFn;
}

describe("fed.cloudflare.up", () => {
  it("selfEndpoint() is byte-identical to today before any Cloudflare provisioning", async () => {
    const home = makeHome();
    const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
    const engine = new Engine({ home, backends, keychain: new InMemoryKeychain() });
    const created = (await engine.handle("fed.invite.create", {})) as { blob: string };
    expect(created.blob).toContain("chimera-pair:v1;");
    const decoded = JSON.parse(Buffer.from(created.blob.slice("chimera-pair:v1;".length), "base64").toString("utf8"));
    expect(decoded.endpoint.cloudflareAccess).toBeUndefined();
  });

  it("fed.invite.create refuses while selfprobe is pending", async () => {
    const home = makeHome();
    const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
    const probe: ProbeFn = async () => ({ sawSshBanner: false }); // never passes -> selfprobe stays "failed"/pending
    const engine = new Engine({
      home, backends, keychain: new InMemoryKeychain(),
      cfFetch: fakeCfFetch(), cfProbe: probe, cfSelfprobeRetryWindowMs: 0,
    });
    await engine.handle("fed.cloudflare.up", { apiToken: "tok", domain: "example.com" });
    await expect(engine.handle("fed.invite.create", {})).rejects.toBeTruthy();
  });

  it("fed.cloudflare.up reaching selfprobe:passed makes selfEndpoint() include cloudflareAccess with no secret", async () => {
    const home = makeHome();
    const backends = new Map([["claude", new FakeAgentBackend([], "claude")]]);
    const probe: ProbeFn = async ({ withToken }) => ({ sawSshBanner: withToken !== null });
    const userSshDir = mkdtempSync(join(tmpdir(), "chm-cf-eng-usersshdir-"));
    const engine = new Engine({
      home, backends, keychain: new InMemoryKeychain(),
      cfFetch: fakeCfFetch(), cfProbe: probe,
      netExec: fakeSshKeygenExec, readHostKeys: () => [], userSshDir,
    });
    const result = (await engine.handle("fed.cloudflare.up", { apiToken: "tok", domain: "example.com" })) as {
      status: { selfprobe: string; hostname: string | null };
    };
    expect(result.status.selfprobe).toBe("passed");

    const created = (await engine.handle("fed.invite.create", {})) as { blob: string };
    const decoded = JSON.parse(Buffer.from(created.blob.slice("chimera-pair:v1;".length), "base64").toString("utf8"));
    expect(decoded.endpoint.cloudflareAccess).toEqual({ hostname: "studio.example.com", clientId: "cid-1" });
    expect(JSON.stringify(decoded)).not.toContain("secret-xyz");
    // §13a/b: the ssh-layer bootstrap fields are present (shown-once) once cloudflareAccess is set.
    expect(typeof decoded.inviteKeyPrivate).toBe("string");
    expect(typeof decoded.fedSshPublicKey).toBe("string");
  });
});
