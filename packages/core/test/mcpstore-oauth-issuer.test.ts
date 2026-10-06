import { describe, expect, it } from "vitest";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { InMemoryKeychain, mcpStoreAuthService } from "../src/keychain.js";
import { KeychainOAuthClientProvider, readMcpStoreOAuthSnapshot } from "../src/providers/oauth-client-provider.js";

const resource = "https://resource.example/mcp";
const legitimate = "https://auth.example/";
const attacker = "https://attacker.example/";
const service = mcpStoreAuthService("issuer-test");
const provider = (keychain: InMemoryKeychain) =>
  new KeychainOAuthClientProvider("issuer-test", keychain, "http://127.0.0.1:12345/callback", ["read"]);

// Discovery and token exchange use the real SDK with synthetic fetch responses. No network,
// OS keychain, provider account, or operator MCP connection participates in these tests.
function authorizationServer(issuer: string, metadataIssuer = issuer) {
  const posts: { url: string; body: string }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { "content-type": "application/json" },
    });
    if (url.includes("/.well-known/oauth-protected-resource")) {
      return json({ resource, authorization_servers: [issuer] });
    }
    if (url.includes("/.well-known/oauth-authorization-server")) {
      return json({ issuer: metadataIssuer, authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`, registration_endpoint: `${issuer}register`,
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "none"] });
    }
    posts.push({ url, body: String(init?.body ?? "") });
    if (url === `${issuer}register`) {
      return json({ ...JSON.parse(String(init?.body)), client_id: "fresh-client", client_secret: "fresh-secret" }, 201);
    }
    if (url === `${issuer}token`) {
      return json({ access_token: "fresh-access", refresh_token: "fresh-refresh", token_type: "Bearer" });
    }
    throw new Error(`Unexpected synthetic request: ${url}`);
  };
  return { fetchFn, posts };
}

function storedGrant(issuer?: unknown) {
  return {
    tokens: { access_token: "stored-access", refresh_token: "stored-refresh", token_type: "Bearer", issuer },
    clientInfo: { client_id: "stored-client", client_secret: "stored-secret", issuer },
    authorizedAt: 123,
  };
}

describe("MCP OAuth issuer binding", () => {
  it.each([undefined, null, "", " \t\n ", 42, "not-a-url", "file:///tmp/issuer"])("withholds credentials with unusable issuer %s without rewriting storage", async issuer => {
    const raw = JSON.stringify(storedGrant(issuer));
    const keychain = new InMemoryKeychain({ [service]: raw });
    const restored = provider(keychain);
    expect(await restored.tokens()).toBeUndefined();
    expect(await restored.clientInformation()).toBeUndefined();
    expect(await readMcpStoreOAuthSnapshot(keychain, "issuer-test")).toEqual({ hasTokens: false, hasRefreshToken: false });
    expect(await keychain.get(service)).toBe(raw);
  });

  it("preserves the exact issuer spelling on save and cold restore", async () => {
    const keychain = new InMemoryKeychain();
    const issuer = "https://AUTH.example:443/issuer";
    const first = provider(keychain);
    const tokens = { access_token: "synthetic-access", token_type: "Bearer", issuer };
    const clientInfo = { client_id: "synthetic-client", issuer };
    await first.saveTokens(tokens);
    await first.saveClientInformation(clientInfo);
    const restored = provider(keychain);
    expect(await restored.tokens()).toEqual(tokens);
    expect(await restored.clientInformation()).toEqual(clientInfo);
    expect(JSON.parse((await keychain.get(service))!).tokens.issuer).toBe(issuer);
    expect(JSON.parse((await keychain.get(service))!).clientInfo.issuer).toBe(issuer);
  });

  it("preserves SDK-stamped registration and tokens across a fresh provider instance", async () => {
    const keychain = new InMemoryKeychain();
    const first = provider(keychain);
    const server = authorizationServer(legitimate);
    expect(await auth(first, { serverUrl: resource, fetchFn: server.fetchFn })).toBe("REDIRECT");
    expect(await auth(first, { serverUrl: resource, authorizationCode: "synthetic-code", fetchFn: server.fetchFn })).toBe("AUTHORIZED");
    const restored = provider(keychain);
    expect(await restored.clientInformation()).toMatchObject({ client_id: "fresh-client", issuer: legitimate });
    expect(await restored.tokens()).toMatchObject({ access_token: "fresh-access", issuer: legitimate });
    expect(await readMcpStoreOAuthSnapshot(keychain, "issuer-test")).toMatchObject({ hasTokens: true, hasRefreshToken: true });
  });

  it("refreshes a grant only at its original issuer after a cold restore", async () => {
    const keychain = new InMemoryKeychain({ [service]: JSON.stringify(storedGrant(legitimate)) });
    const server = authorizationServer(legitimate);
    expect(await auth(provider(keychain), { serverUrl: resource, fetchFn: server.fetchFn })).toBe("AUTHORIZED");
    expect(server.posts).toHaveLength(1);
    expect(server.posts[0]?.url).toBe(`${legitimate}token`);
    const params = new URLSearchParams(server.posts[0]?.body);
    expect(params.get("refresh_token")).toBe("stored-refresh");
    expect(params.get("client_secret")).toBe("stored-secret");
    expect(await provider(keychain).tokens()).toMatchObject({ issuer: legitimate });
  });

  it.each([legitimate, undefined])("does not post cached secrets when discovery changes issuer (stored issuer %s)", async issuer => {
    const keychain = new InMemoryKeychain({ [service]: JSON.stringify(storedGrant(issuer)) });
    // The attacker also echoes the legitimate issuer in metadata: binding must follow the
    // actual discovered authorization-server URL, rather than that untrusted document field.
    const server = authorizationServer(attacker, legitimate);
    const restored = provider(keychain);
    expect(await auth(restored, { serverUrl: resource, fetchFn: server.fetchFn })).toBe("REDIRECT");
    expect(server.posts.map(p => p.url)).toEqual([`${attacker}register`]);
    expect(JSON.stringify(server.posts)).not.toMatch(/stored-(refresh|secret|client|access)/);
    expect(new URL(restored.authorizeUrl!).origin).toBe(new URL(attacker).origin);
    expect(await provider(keychain).clientInformation()).toMatchObject({ issuer: attacker });
  });

  it.each([
    { label: "bound token, legacy client at A", tokenIssuer: legitimate, clientIssuer: undefined, discovered: legitimate },
    { label: "bound token, legacy client at B", tokenIssuer: legitimate, clientIssuer: undefined, discovered: attacker },
    { label: "legacy token, bound client at A", tokenIssuer: undefined, clientIssuer: legitimate, discovered: legitimate },
    { label: "legacy token, bound client at B", tokenIssuer: undefined, clientIssuer: legitimate, discovered: attacker },
  ])("filters mixed credentials independently: $label", async ({ tokenIssuer, clientIssuer, discovered }) => {
    const grant = {
      tokens: storedGrant(tokenIssuer).tokens,
      clientInfo: storedGrant(clientIssuer).clientInfo,
      authorizedAt: 123,
    };
    const raw = JSON.stringify(grant);
    const keychain = new InMemoryKeychain({ [service]: raw });
    const restored = provider(keychain);
    expect(await restored.tokens()).toEqual(tokenIssuer ? grant.tokens : undefined);
    expect(await restored.clientInformation()).toEqual(clientIssuer ? grant.clientInfo : undefined);
    expect(await readMcpStoreOAuthSnapshot(keychain, "issuer-test")).toMatchObject({
      hasTokens: !!tokenIssuer, hasRefreshToken: !!tokenIssuer,
    });
    expect(await keychain.get(service)).toBe(raw);

    const server = authorizationServer(discovered, legitimate);
    const result = await auth(restored, { serverUrl: resource, fetchFn: server.fetchFn });
    // Only a bound A token at A can refresh. Missing client info triggers fresh DCR;
    // a bound A client alone can start sign-in at A, but cannot revive a legacy token.
    const canRefresh = !!tokenIssuer && discovered === legitimate;
    const canReuseClient = !!clientIssuer && discovered === legitimate;
    expect(result).toBe(canRefresh ? "AUTHORIZED" : "REDIRECT");
    const expectedPosts = [
      ...(!canReuseClient ? [`${discovered}register`] : []),
      ...(canRefresh ? [`${discovered}token`] : []),
    ];
    expect(server.posts.map(p => p.url)).toEqual(expectedPosts);
    expect(JSON.stringify(server.posts)).not.toContain("stored-secret");
    const tokenPost = server.posts.find(p => p.url === `${discovered}token`);
    expect(tokenPost ? new URLSearchParams(tokenPost.body).get("refresh_token") : undefined)
      .toBe(canRefresh ? "stored-refresh" : undefined);
    if (discovered === attacker) {
      expect(JSON.stringify(server.posts)).not.toMatch(/stored-(refresh|secret|client|access)/);
    }
    if (canReuseClient) expect(await restored.clientInformation()).toEqual(grant.clientInfo);
    if (!canRefresh) {
      expect(JSON.parse((await keychain.get(service))!).tokens).toEqual(JSON.parse(raw).tokens);
      expect(await restored.tokens()).toEqual(tokenIssuer ? grant.tokens : undefined);
    }
  });
});
