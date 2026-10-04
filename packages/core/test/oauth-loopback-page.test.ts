import { describe, it, expect } from "vitest";
import { OAuthLoopbackListener } from "@chimera/core/providers/oauth-loopback";

// The callback page is the one chimera surface that renders OUTSIDE the app/TUI — a browser tab
// the operator is looking at when a connect flow ends. It has no bundler, no stylesheet and no
// test harness around it, so these drive the REAL listener over HTTP: what a browser would get.

const get = async (url: string): Promise<{ status: number; contentType: string; body: string }> => {
  const res = await fetch(url);
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", body: await res.text() };
};

describe("oauth loopback callback page", () => {
  it("renders a themed HTML success page naming the server, not a bare text line", async () => {
    const l = await OAuthLoopbackListener.start();
    l.setServerName("cloudflare-api");
    l.onCallback(async () => ({ accepted: true, done: false }));

    const r = await get(`${l.redirectUrl}?code=c&state=s`);
    expect(r.status).toBe(200);
    expect(r.contentType).toContain("text/html");
    expect(r.body).toContain("<!doctype html>");
    expect(r.body).toContain("Connected");
    expect(r.body).toContain("cloudflare-api");           // says WHICH server, the point of setServerName
    expect(r.body).toContain("#14161a");                  // the app's --bg, so it reads as one product
    await l.close();
  });

  it("says the request failed — and does NOT claim a connection — on a rejected callback", async () => {
    const l = await OAuthLoopbackListener.start();
    l.setServerName("cloudflare-api");
    l.onCallback(async () => ({ accepted: false, done: true }));

    const r = await get(`${l.redirectUrl}?code=c&state=wrong`);
    expect(r.status).toBe(400);                            // status semantics unchanged by the reskin
    expect(r.body).toContain("Authorization failed");
    expect(r.body).not.toContain("Connected");
  });

  it("escapes the server name rather than interpolating it into the markup", async () => {
    // McpStoreNameSchema already restricts names to [a-z0-9-]; this pins the SECOND line of
    // defence, so loosening that validator can never turn this page into an injection.
    const l = await OAuthLoopbackListener.start();
    l.setServerName("<script>alert(1)</script>" as string);
    l.onCallback(async () => ({ accepted: true, done: false }));

    const r = await get(`${l.redirectUrl}?code=c&state=s`);
    expect(r.body).not.toContain("<script>alert(1)</script>");
    expect(r.body).toContain("&lt;script&gt;");
    await l.close();
  });

  it("still renders without a server name, and still closes itself when the flow is done", async () => {
    const l = await OAuthLoopbackListener.start();
    l.onCallback(async () => ({ accepted: true, done: true }));

    const r = await get(`${l.redirectUrl}?code=c&state=s`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("Connected");
    // `done:true` closes the listener once the response flushes — the port must stop answering.
    await new Promise((res) => setTimeout(res, 100));
    await expect(get(`${l.redirectUrl}?code=c&state=s`)).rejects.toThrow();
  });

  it("leaves the malformed/no-flow paths as plain text — they are not operator-facing pages", async () => {
    const l = await OAuthLoopbackListener.start();
    const missing = await get(`${l.redirectUrl}`);
    expect(missing.status).toBe(400);
    expect(missing.body).toBe("missing code or state");
    const notFound = await get(`http://127.0.0.1:${new URL(l.redirectUrl).port}/nope`);
    expect(notFound.status).toBe(404);
    await l.close();
  });
});
