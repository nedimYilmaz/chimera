import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { OperatorWeb } from "../src/operator-web.js";
import { OperatorWebSettingsSchema } from "@chimera/protocol";
async function rawHttp(url: string, method: string, headers: Record<string, string>, body?: string): Promise<Response> {
  return new Promise((ok, reject) => {
    const req = http.request(url, { method, headers: { ...headers, ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}) } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(Buffer.from(c))); res.on("end", () => {
        const responseHeaders = new Headers(); for (const [key, value] of Object.entries(res.headers)) { if (Array.isArray(value)) for (const v of value) responseHeaders.append(key, v); else if (value !== undefined) responseHeaders.set(key, value); }
        ok(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers: responseHeaders }));
      });
    }); req.on("error", reject); req.end(body);
  });
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); });
async function fixture(savedSettings?: string) {
  const home = mkdtempSync(join(tmpdir(), "chimera-operator-test-")); let now = Date.now(); let visible = true;
  if (savedSettings !== undefined) writeFileSync(join(home, "operator-web.json"), savedSettings);
  const dispatch = vi.fn(async () => ({ ok: true })), callbacks = new Set<(id: string) => void>(), audit = vi.fn();
  const web = new OperatorWeb({ home, bundleDir: join(home, "bundle"), now: () => now, projectExists: p => p === "one" && visible,
    snapshot: async s => ({ project: s.project, scope: s.scope, agents: [], attention: [], queues: [], truncated: false }), dispatch,
    subscribe: cb => { callbacks.add(cb); return () => { callbacks.delete(cb); }; }, visible: (_s, id) => id === "a", audit });
  cleanup.push(async () => { await web.close(); rmSync(home, { recursive: true, force: true }); });
  expect(web.status().enabled).toBe(false); const status = savedSettings === undefined ? await web.enable() : web.status(); const url = status.localUrl!;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => rawHttp(web.status().localUrl! + path, "POST", { Origin: web.status().localUrl!, "Content-Type": "application/json", ...headers }, typeof body === "string" ? body : JSON.stringify(body));
  const pair = async (control = false) => {
    const code = web.pairStart({ project: "one", allowControl: control }).code;
    const response = await post("/pair", { code, deviceLabel: "Test device", scope: control ? "control" : "read" });
    expect(response.status).toBe(200);
    const meta = await response.json(); const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return { meta, cookie, code, headers: { Cookie: cookie, "X-Chimera-CSRF": meta.csrf } };
  };
  const rpc = (headers: Record<string, string>, method = "agent.send", params = { agentId: "a", text: "hello" }) => post("/rpc", { id: "1", method, params }, headers);
  return { web, url, pair, post, rpc, dispatch, callbacks, audit, home, advance: (ms: number) => { now += ms; }, removeProject: () => { visible = false; } };
}
describe("operator HTTP boundary", () => {
  it("pairs once; cookie is HttpOnly/Strict; read rejects control; revocation rejects replay", async () => {
    const f = await fixture();
    expect((await fetch(f.url + "/snapshot")).status).toBe(401);
    const s = await f.pair();
    expect(s.meta).not.toHaveProperty("token");
    expect((await f.post("/pair", { code: s.code, deviceLabel: "Replay", scope: "read" })).status).toBe(401);
    expect((await fetch(f.url + "/snapshot", { headers: s.headers })).status).toBe(200);
    expect((await f.rpc(s.headers)).status).toBe(403); expect(f.dispatch).not.toHaveBeenCalled();
    const c = await f.pair(true); expect((await f.rpc(c.headers)).status).toBe(200); expect(f.audit).toHaveBeenCalledOnce();
    expect((await f.rpc(c.headers)).status).toBe(409); expect(f.dispatch).toHaveBeenCalledOnce();
    const list = f.web.sessionList(); expect(JSON.stringify(list)).not.toContain(s.cookie.slice(s.cookie.indexOf("=") + 1));
    f.web.revoke(list.find(x => x.scope === "control")!.id);
    expect((await f.rpc(c.headers)).status).toBe(401); expect(f.dispatch).toHaveBeenCalledOnce();
    f.web.revoke(null); expect((await fetch(f.url + "/session", { headers: s.headers })).status).toBe(401);
  });
  it("requires exact host, origin and CSRF; rejects malicious methods and oversized bodies", async () => {
    const f = await fixture(); const s = await f.pair(true);
    expect((await f.rpc({ ...s.headers, Origin: "https://evil.example" })).status).toBe(403);
    expect((await f.rpc({ Cookie: s.cookie })).status).toBe(403);
    expect((await f.rpc({ ...s.headers, Host: "evil.example" })).status).toBe(403);
    expect((await f.rpc({ ...s.headers, Host: "rebound.example", "X-Forwarded-Host": new URL(f.url).host, "X-Forwarded-Proto": "https" })).status).toBe(403);
    expect((await f.rpc({ ...s.headers, Origin: "null" })).status).toBe(403);
    expect((await f.post("/rpc", { id: "x", method: "operatorweb.enable", params: {} }, s.headers)).status).toBe(403);
    expect((await f.post("/rpc", "a".repeat(1_048_577), s.headers)).status).toBe(413);
    expect((await fetch(f.url + "/events?token=leak", { headers: s.headers })).status).toBe(400);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("expires pairing, idle and absolute sessions; project removal revokes current access", async () => {
    const f = await fixture(); const code = f.web.pairStart({ project: "one", allowControl: false }).code;
    f.advance(120_000); expect((await f.post("/pair", { code, deviceLabel: "Expired" })).status).toBe(401);
    const s = await f.pair(); f.advance(30 * 60_000); expect((await fetch(f.url + "/snapshot", { headers: s.headers })).status).toBe(401);
    const c = await f.pair(); f.removeProject(); expect((await fetch(f.url + "/session", { headers: c.headers })).status).toBe(401);
  });
  it("cannot escalate read pairing, rate-limits failures and resets credentials on disable", async () => {
    const f = await fixture(); const code = f.web.pairStart({ project: "one", allowControl: false }).code;
    expect((await f.post("/pair", { code, deviceLabel: "Escalate", scope: "control" })).status).toBe(403);
    for (let i = 0; i < 4; i++) expect((await f.post("/pair", { code: "0".repeat(32), deviceLabel: "Wrong" })).status).toBe(401);
    expect((await f.post("/pair", { code, deviceLabel: "Correct" })).status).toBe(429);
    f.advance(60_001); const s = await f.pair(); await f.web.disable(); await f.web.enable();
    expect(f.web.sessionList()).toEqual([]); expect(f.web.status().enabled).toBe(true); void s;
  });
  it("requires HTTPS external origin; preserves preferences but never enables on construction", async () => {
    const f = await fixture(); await f.web.disable();
    expect(() => OperatorWebSettingsSchema.parse({ publicOrigin: "http://example.com" })).toThrow();
    await f.web.settingsSet(OperatorWebSettingsSchema.parse({ publicOrigin: "https://operator.example", absoluteH: 0.01 }));
    await f.web.enable(); const code = f.web.pairStart({ project: "one", allowControl: false }).code;
    const response = await f.post("/pair", { code, deviceLabel: "TLS device" }, { Host: "operator.example", Origin: "https://operator.example" });
    expect(response.status).toBe(200); const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("__Host-chimera_operator="); expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict"); expect(cookie).toContain("; Secure");
    const token = cookie.split(";")[0]!; const activeUrl = f.web.status().localUrl!;
    expect((await fetch(activeUrl + "/session", { headers: { Cookie: token } })).status).toBe(401);
    const headers = { Cookie: token, Host: "operator.example" }; f.advance(36_001);
    expect((await rawHttp(activeUrl + "/session", "GET", headers)).status).toBe(401);
    const reload = new OperatorWeb({ home: f.home, bundleDir: "missing", projectExists: () => true, snapshot: async () => { throw Error(); }, dispatch: async () => {}, subscribe: () => () => {}, visible: () => false, audit: () => {} });
    expect(reload.status()).toMatchObject({ enabled: false, settings: { publicOrigin: "https://operator.example" }, sessions: [] });
  });
  it("serves an honest missing bundle state and confines static files", async () => {
    const f = await fixture(); expect((await fetch(f.url)).status).toBe(503);
    mkdirSync(join(f.home, "bundle", "assets"), { recursive: true }); writeFileSync(join(f.home, "bundle", "operator.html"), "<h1>Panel</h1>");
    const response = await fetch(f.url); expect(response.status).toBe(200); expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await fetch(f.url + "/operator-web.json")).status).toBe(404);
  });
  it("streams only scoped invalidations and closes immediately on revoke", async () => {
    const f = await fixture(), s = await f.pair();
    const response = await fetch(f.url + "/events", { headers: s.headers }); expect(response.status).toBe(200);
    const reader = response.body!.getReader(); const first = new TextDecoder().decode((await reader.read()).value); expect(first).toContain("connected");
    for (const cb of f.callbacks) cb("outside");
    f.advance(1000); for (const cb of f.callbacks) cb("a");
    const changed = new TextDecoder().decode((await reader.read()).value); expect(changed).toBe('event: changed\ndata: {}\n\n');
    // A second event inside the rate window must get a trailing notice.
    for (const cb of f.callbacks) cb("a");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: changed\ndata: {}\n\n');
    f.web.revoke(null); expect((await reader.read()).done).toBe(true); expect(f.callbacks.size).toBe(0);
  });
  it("caps event streams per device and releases them on revoke", async () => {
    const f = await fixture(), s = await f.pair();
    const one = await fetch(f.url + "/events", { headers: s.headers });
    const two = await fetch(f.url + "/events", { headers: s.headers });
    expect(one.status).toBe(200); expect(two.status).toBe(200);
    expect((await fetch(f.url + "/events", { headers: s.headers })).status).toBe(429);
    f.web.revoke(null); await one.body!.cancel(); await two.body!.cancel(); expect(f.callbacks.size).toBe(0);
  });
  it("rejects WebSocket upgrades", async () => {
    const f = await fixture(); const status = await new Promise<number>((ok, reject) => {
      const req = http.request(f.url + "/events", { headers: { Connection: "Upgrade", Upgrade: "websocket", Origin: "https://evil.example" } });
      req.on("response", res => { res.resume(); ok(res.statusCode!); }); req.on("error", reject); req.end();
    }); expect(status).toBe(403);
  });
});


it.each(['{"v":2,"futureSetting":"preserve me"}', '{broken-json'])('preserves unreadable settings and refuses activation/overwrite: %s', async contents => {
  const f = await fixture(contents);
  await expect(f.web.settingsSet(OperatorWebSettingsSchema.parse({}))).rejects.toMatchObject({ code: "unsupported" });
  expect(f.web.status().limitation).toMatch(/settings.*preserved.*read.only/i);
  await expect(f.web.enable()).rejects.toMatchObject({ code: "unsupported" });
  expect(readFileSync(join(f.home, "operator-web.json"), "utf8")).toBe(contents);
  expect(f.web.status()).toMatchObject({ enabled: false, localUrl: null });
});
