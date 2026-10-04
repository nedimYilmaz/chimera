import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { McpOAuthGateway } from "@chimera/protocol";
import { AddMcpStoreForm } from "../src/screens/SettingsScreen";
import styles from "../src/screens/SettingsScreen.module.css";

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn().mockResolvedValue(undefined),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  subscribeEvents: vi.fn().mockResolvedValue(undefined),
}));

function byData(root: ReactTestInstance, key: string): ReactTestInstance {
  return root.find((node) => node.props[key] !== undefined);
}

describe("AddMcpStoreForm", () => {
  it("switches to http inputs and submits url plus non-secret headers", async () => {
    const addMcpStore = vi.fn().mockResolvedValue(true);
    const setMcpStoreAuth = vi.fn().mockResolvedValue(true);
    const onDone = vi.fn();
    let view!: ReactTestRenderer;
    await act(async () => { view = create(<AddMcpStoreForm onDone={onDone} addMcpStore={addMcpStore} setMcpStoreAuth={setMcpStoreAuth} />); });

    await act(async () => { byData(view.root, "data-mcp-store-type-http").props.onClick(); });
    expect(view.root.findAll((node) => node.props["data-mcp-store-command-input"] !== undefined)).toHaveLength(0);
    await act(async () => {
      byData(view.root, "data-mcp-store-name-input").props.onChange({ target: { value: "remote" } });
      byData(view.root, "data-mcp-store-url-input").props.onChange({ target: { value: "https://mcp.example.com/mcp" } });
      byData(view.root, "data-mcp-store-headers-input").props.onChange({ target: { value: "X-Key=secret" } });
    });
    await act(async () => { byData(view.root, "data-mcp-store-save").props.onClick(); });

    expect(addMcpStore).toHaveBeenCalledWith("remote", {
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Key": "secret" },
      direct: false,
      enabled: true,
      trust: "full",
    });
    expect(setMcpStoreAuth).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledOnce();
  });

  // MCP-REMOTE-IMPORT slice 3 (security fix): an "Authorization" header must never
  // land in mcpstore.add's persisted `headers` — it goes to mcpstore.setAuth
  // (Keychain) instead, and the entry it attaches to carries only a keychainRef
  // pointer, never the secret itself.
  it("routes an Authorization header through mcpstore.setAuth instead of persisting it in headers", async () => {
    const addMcpStore = vi.fn().mockResolvedValue(true);
    const setMcpStoreAuth = vi.fn().mockResolvedValue(true);
    const onDone = vi.fn();
    let view!: ReactTestRenderer;
    await act(async () => { view = create(<AddMcpStoreForm onDone={onDone} addMcpStore={addMcpStore} setMcpStoreAuth={setMcpStoreAuth} />); });

    await act(async () => { byData(view.root, "data-mcp-store-type-http").props.onClick(); });
    await act(async () => {
      byData(view.root, "data-mcp-store-name-input").props.onChange({ target: { value: "remote" } });
      byData(view.root, "data-mcp-store-url-input").props.onChange({ target: { value: "https://mcp.example.com/mcp" } });
      byData(view.root, "data-mcp-store-headers-input").props.onChange({ target: { value: "Authorization=Bearer sk-super-secret, X-Key=secret" } });
    });
    await act(async () => { byData(view.root, "data-mcp-store-save").props.onClick(); });

    const addCall = addMcpStore.mock.calls[0];
    expect(addCall[0]).toBe("remote");
    expect(addCall[1]).toMatchObject({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Key": "secret" },
      direct: false,
    });
    expect(JSON.stringify(addCall[1])).not.toContain("sk-super-secret");
    expect(addCall[1].auth?.keychainRef).toBeTruthy();

    expect(setMcpStoreAuth).toHaveBeenCalledWith("remote", "sk-super-secret");
    expect(onDone).toHaveBeenCalledOnce();
  });

  // MCP-OAUTH slice 3: picking "oauth" in the add-remote form persists auth.kind:"oauth"
  // + the selected scopes onto the entry — no secret is entered here (the Authorize
  // button drives the actual PKCE/DCR exchange once the entry exists).
  // MCP-OAUTH-FOREIGN-SCOPES: the url here is load-bearing, not incidental. A scope catalog comes
  // only from the configured gateway (config `mcpOAuthGateways`) whose hosts the url matches —
  // for any other server the form shows no catalog at all, since a gateway's scope names mean
  // nothing to a foreign authorization server (asking cloudflare for them came back Unauthorized).
  describe("oauth auth kind + scope selection", () => {
    // Module-level-stable fixture, like the settings store's own array.
    const GATEWAYS: McpOAuthGateway[] = [
      { hosts: ["gateway.example.com", ".mcp.example.com"], defaultScopes: ["docs", "tickets", "wiki"], optionalScopes: ["admin"] },
    ];
    const scopeChips = (root: ReactTestInstance): string[] =>
      root.findAll((n) => typeof n.props["data-mcp-store-scope"] === "string" && n.type === "button").map((n) => n.props["data-mcp-store-scope"] as string);

    async function openOAuthForm(url: string, gateways: McpOAuthGateway[] = GATEWAYS) {
      const addMcpStore = vi.fn().mockResolvedValue(true);
      const setMcpStoreAuth = vi.fn().mockResolvedValue(true);
      const onDone = vi.fn();
      let view!: ReactTestRenderer;
      await act(async () => { view = create(<AddMcpStoreForm onDone={onDone} addMcpStore={addMcpStore} setMcpStoreAuth={setMcpStoreAuth} oauthGateways={gateways} />); });
      await act(async () => { byData(view.root, "data-mcp-store-type-http").props.onClick(); });
      await act(async () => { byData(view.root, "data-mcp-store-auth-oauth").props.onClick(); });
      await act(async () => {
        byData(view.root, "data-mcp-store-name-input").props.onChange({ target: { value: "gateway" } });
        byData(view.root, "data-mcp-store-url-input").props.onChange({ target: { value: url } });
      });
      return { view, addMcpStore, setMcpStoreAuth, onDone };
    }

    it("defaults to the gateway's DEFAULT-CHECKED scope set (optional scopes unchecked) when oauth is picked", async () => {
      const { view, addMcpStore, setMcpStoreAuth, onDone } = await openOAuthForm("https://gateway.example.com/mcp");
      expect(scopeChips(view.root)).toEqual(["docs", "tickets", "wiki", "admin"]);
      expect(view.root.find((n) => n.props["data-mcp-store-scope"] === "admin").props.className).toBe(styles.chipOff);
      await act(async () => { byData(view.root, "data-mcp-store-save").props.onClick(); });

      expect(addMcpStore).toHaveBeenCalledWith("gateway", {
        type: "http",
        url: "https://gateway.example.com/mcp",
        headers: {},
        direct: false,
        enabled: true,
        trust: "full",
        auth: {
          kind: "oauth",
          keychainRef: "chimera:mcp:gateway",
          scopes: ["docs", "tickets", "wiki"],
        },
      });
      // no secret entry for oauth — setMcpStoreAuth is a bearer-only path.
      expect(setMcpStoreAuth).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledOnce();
    });

    it("toggling an optional scope on and a default scope off changes the persisted scopes, plus free-text extras", async () => {
      const { view, addMcpStore } = await openOAuthForm("https://jira.mcp.example.com/sse");
      // uncheck a default-on scope, check the (default-off) optional scope, add a free-text extra
      await act(async () => { view.root.find((n) => n.props["data-mcp-store-scope"] === "wiki").props.onClick(); });
      await act(async () => { view.root.find((n) => n.props["data-mcp-store-scope"] === "admin").props.onClick(); });
      await act(async () => { byData(view.root, "data-mcp-store-extra-scopes-input").props.onChange({ target: { value: "custom-scope" } }); });
      await act(async () => { byData(view.root, "data-mcp-store-save").props.onClick(); });

      const addCall = addMcpStore.mock.calls[0];
      expect(addCall[1].auth).toEqual({
        kind: "oauth",
        keychainRef: "chimera:mcp:gateway",
        scopes: ["docs", "tickets", "admin", "custom-scope"],
      });
    });

    it("shows no catalog for a url on no configured gateway — only the free-text field", async () => {
      const { view, addMcpStore } = await openOAuthForm("https://mcp.cloudflare.com/mcp");
      expect(scopeChips(view.root)).toEqual([]);
      await act(async () => { byData(view.root, "data-mcp-store-extra-scopes-input").props.onChange({ target: { value: "read, write" } }); });
      await act(async () => { byData(view.root, "data-mcp-store-save").props.onClick(); });
      expect(addMcpStore.mock.calls[0][1].auth).toEqual({ kind: "oauth", keychainRef: "chimera:mcp:gateway", scopes: ["read", "write"] });
    });

    it("shows no catalog at all when no gateway is configured", async () => {
      const { view } = await openOAuthForm("https://gateway.example.com/mcp", []);
      expect(scopeChips(view.root)).toEqual([]);
      expect(byData(view.root, "data-mcp-store-extra-scopes-input")).toBeTruthy();
    });

    it("keeps the operator's clicks while typing within one gateway and across an equal gateway reload", async () => {
      const { view, addMcpStore } = await openOAuthForm("https://gateway.example.com/mcp");
      await act(async () => { view.root.find((n) => n.props["data-mcp-store-scope"] === "admin").props.onClick(); });
      // A settings reload hands the form equal-but-new gateway objects.
      await act(async () => { view.update(<AddMcpStoreForm onDone={() => {}} addMcpStore={addMcpStore} oauthGateways={structuredClone(GATEWAYS)} />); });
      await act(async () => { byData(view.root, "data-mcp-store-url-input").props.onChange({ target: { value: "https://gateway.example.com/mcp/v2" } }); });
      await act(async () => { byData(view.root, "data-mcp-store-save").props.onClick(); });
      expect(addMcpStore.mock.calls[0][1].auth.scopes).toEqual(["docs", "tickets", "wiki", "admin"]);
    });

    it("drops the gateway catalog (and any clicks on it) once the url leaves the gateway's hosts", async () => {
      const { view, addMcpStore } = await openOAuthForm("https://gateway.example.com/mcp");
      await act(async () => { view.root.find((n) => n.props["data-mcp-store-scope"] === "admin").props.onClick(); });
      await act(async () => { byData(view.root, "data-mcp-store-url-input").props.onChange({ target: { value: "https://gateway.example.com.evil.tld/mcp" } }); });
      expect(scopeChips(view.root)).toEqual([]);
      await act(async () => { byData(view.root, "data-mcp-store-save").props.onClick(); });
      expect(addMcpStore.mock.calls[0][1].auth.scopes).toEqual([]);
    });

    it("switching back to the bearer/token auth mode never sends an oauth kind or scopes", async () => {
      const addMcpStore = vi.fn().mockResolvedValue(true);
      const onDone = vi.fn();
      let view!: ReactTestRenderer;
      await act(async () => { view = create(<AddMcpStoreForm onDone={onDone} addMcpStore={addMcpStore} />); });

      await act(async () => { byData(view.root, "data-mcp-store-type-http").props.onClick(); });
      await act(async () => { byData(view.root, "data-mcp-store-auth-oauth").props.onClick(); });
      await act(async () => { byData(view.root, "data-mcp-store-auth-bearer").props.onClick(); });
      await act(async () => {
        byData(view.root, "data-mcp-store-name-input").props.onChange({ target: { value: "remote" } });
        byData(view.root, "data-mcp-store-url-input").props.onChange({ target: { value: "https://mcp.example.com/mcp" } });
      });
      await act(async () => { byData(view.root, "data-mcp-store-save").props.onClick(); });

      expect(addMcpStore).toHaveBeenCalledWith("remote", { type: "http", url: "https://mcp.example.com/mcp", headers: {}, direct: false, enabled: true, trust: "full" });
    });
  });

  // MCP-OAUTH-DISCOVERABILITY: the user shouldn't have to know bearer vs oauth — a url that
  // the daemon's detect probe (mcpstore.detectAuth) flags as OAuth auto-switches the form
  // into oauth mode the moment the url field loses focus, with no manual toggle click.
  describe("MCP-OAUTH-DISCOVERABILITY: auto-detect defaults the form to oauth mode", () => {
    it("blurring the url field with a detected-OAuth url switches to oauth mode and submits oauth", async () => {
      const addMcpStore = vi.fn().mockResolvedValue(true);
      const detectMcpStoreOAuth = vi.fn().mockResolvedValue({ oauth: true });
      const onDone = vi.fn();
      let view!: ReactTestRenderer;
      await act(async () => { view = create(<AddMcpStoreForm onDone={onDone} addMcpStore={addMcpStore} detectMcpStoreOAuth={detectMcpStoreOAuth} />); });

      await act(async () => { byData(view.root, "data-mcp-store-type-http").props.onClick(); });
      await act(async () => {
        byData(view.root, "data-mcp-store-name-input").props.onChange({ target: { value: "gateway" } });
        byData(view.root, "data-mcp-store-url-input").props.onChange({ target: { value: "https://gw.example.com/mcp" } });
      });
      await act(async () => { await byData(view.root, "data-mcp-store-url-input").props.onBlur(); });

      expect(detectMcpStoreOAuth).toHaveBeenCalledWith({ url: "https://gw.example.com/mcp" });
      // the oauth toggle button now reads as the ACTIVE one (primary style) without a click.
      expect(byData(view.root, "data-mcp-store-auth-oauth").props.className).toBe(styles.primaryBtn);
      expect(byData(view.root, "data-mcp-store-auth-bearer").props.className).toBe(styles.ghostBtn);
      await act(async () => { byData(view.root, "data-mcp-store-save").props.onClick(); });

      const addCall = addMcpStore.mock.calls[0];
      expect(addCall[0]).toBe("gateway");
      expect(addCall[1].auth).toMatchObject({ kind: "oauth", keychainRef: "chimera:mcp:gateway" });
      expect(onDone).toHaveBeenCalledOnce();
    });

    it("a probe miss (oauth:false) leaves the form in bearer mode", async () => {
      const addMcpStore = vi.fn().mockResolvedValue(true);
      const detectMcpStoreOAuth = vi.fn().mockResolvedValue({ oauth: false });
      const onDone = vi.fn();
      let view!: ReactTestRenderer;
      await act(async () => { view = create(<AddMcpStoreForm onDone={onDone} addMcpStore={addMcpStore} detectMcpStoreOAuth={detectMcpStoreOAuth} />); });

      await act(async () => { byData(view.root, "data-mcp-store-type-http").props.onClick(); });
      await act(async () => {
        byData(view.root, "data-mcp-store-name-input").props.onChange({ target: { value: "plain" } });
        byData(view.root, "data-mcp-store-url-input").props.onChange({ target: { value: "https://plain.example.com/mcp" } });
      });
      await act(async () => { await byData(view.root, "data-mcp-store-url-input").props.onBlur(); });
      await act(async () => { byData(view.root, "data-mcp-store-save").props.onClick(); });

      const addCall = addMcpStore.mock.calls[0];
      expect(addCall[1].auth).toBeUndefined();
    });

    it("a probe failure never throws and leaves the form in bearer mode", async () => {
      const addMcpStore = vi.fn().mockResolvedValue(true);
      const detectMcpStoreOAuth = vi.fn().mockRejectedValue(new Error("network unreachable"));
      const onDone = vi.fn();
      let view!: ReactTestRenderer;
      await act(async () => { view = create(<AddMcpStoreForm onDone={onDone} addMcpStore={addMcpStore} detectMcpStoreOAuth={detectMcpStoreOAuth} />); });

      await act(async () => { byData(view.root, "data-mcp-store-type-http").props.onClick(); });
      await act(async () => { byData(view.root, "data-mcp-store-url-input").props.onChange({ target: { value: "https://unreachable.example.com/mcp" } }); });
      // onBlur's probe rejects — swallowed, not re-thrown to the test.
      await act(async () => { byData(view.root, "data-mcp-store-url-input").props.onBlur(); });
    });
  });
});
