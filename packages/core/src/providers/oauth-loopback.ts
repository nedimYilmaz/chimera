// MCP-OAUTH slice 2: the ephemeral loopback HTTP listener a browser's authorize-code redirect
// lands on. Binds 127.0.0.1 ONLY (never 0.0.0.0 — this is a local single-user redirect target,
// not a network service) on an OS-assigned port (port 0), single route `/callback`. One
// listener serves exactly ONE oauth flow (created fresh per mcpstore.oauth.start, closed after
// the flow completes or times out) -- never long-lived, never shared across servers.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type LoopbackCallback = { code: string; state: string };
// `accepted` picks the HTTP response (200 vs 400); `done` says whether this flow is over and
// the listener should close itself once the response is flushed. The two are NOT the same
// bit: a state mismatch is `accepted:false, done:false` (reject this request, keep listening
// for the legitimate one), while a state-matched-but-failed token exchange is
// `accepted:false, done:true` (the flow is over either way).
export type LoopbackVerdict = { accepted: boolean; done: boolean };

const CALLBACK_PATH = "/callback";

// The page a browser lands on after an authorize redirect — the ONLY chimera surface that ever
// renders outside the app/TUI, and the last thing an operator sees when connecting a server. It
// was `content-type: text/plain` and one bare sentence on a white page, which reads like a
// debugging stub rather than the end of a flow chimera drove. Self-contained by necessity: no
// bundler, no network, no font/asset fetch (a redirect target must render instantly and offline),
// so the markup carries its own inlined styles.
//
// Colours are lifted verbatim from packages/app/src/styles/tokens.css (--bg/--panel/--line/--fg/
// --muted/--accent/--danger) so the page reads as the same product as the cockpit. Copies rather
// than imports: packages/core must not depend on packages/app, and a redirect page cannot load a
// stylesheet from it either. If the app's palette changes, this is a deliberate second edit.
const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

// `serverName` reaches here from the mcpstore entry name, which McpStoreNameSchema already
// restricts to [a-z0-9-]. Escaped anyway: this renders in a browser, and a validator loosening
// one day must not silently turn into an injection here.
function renderCallbackPage(ok: boolean, serverName: string | null): string {
  const title = ok ? "Connected" : "Authorization failed";
  const detail = ok
    ? (serverName
        ? `<b>${escapeHtml(serverName)}</b> is connected and its tools are available to every chimera agent.`
        : "The server is connected and its tools are available to every chimera agent.")
    : "This authorization request is invalid or has expired. Start the flow again from chimera.";
  const accent = ok ? "#9aa3f2" : "#e2766f";
  const glyph = ok
    // Inline SVG, not an emoji: emoji render differently per-platform and would be the one
    // un-themed thing on the page.
    ? `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="${accent}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`
    : `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="${accent}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>chimera — ${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #14161a; color: #d7dbe2; padding: 24px;
    font: 14px/1.6 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    width: 100%; max-width: 440px; background: #171a1f; border: 1px solid #262b34;
    border-radius: 12px; padding: 28px 30px 26px;
  }
  .glyph {
    width: 46px; height: 46px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; background: #1d212a; border: 1px solid #2e3342; margin-bottom: 18px;
  }
  h1 { margin: 0 0 8px; font-size: 19px; font-weight: 600; letter-spacing: -0.01em; color: #d7dbe2; }
  p { margin: 0; color: #a9b0bc; }
  p b { color: #d7dbe2; font-weight: 600; }
  .foot {
    margin-top: 22px; padding-top: 16px; border-top: 1px solid #20242c;
    display: flex; align-items: center; gap: 8px; color: #4e5563; font-size: 12.5px;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: ${accent}; flex: none; }
  .brand { color: #828b9a; font-weight: 600; letter-spacing: 0.02em; }
</style>
</head><body>
  <main class="card">
    <div class="glyph">${glyph}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${detail}</p>
    <div class="foot"><span class="dot"></span><span>${ok
      ? 'You can close this window and return to <span class="brand">chimera</span>.'
      : 'Close this window and retry from <span class="brand">chimera</span>.'}</span></div>
  </main>
</body></html>`;
}

export class OAuthLoopbackListener {
  private port = 0;
  // Purely cosmetic: names the server on the success page. Optional so a caller that does not
  // set it still gets a correct (just less specific) page.
  private serverName: string | null = null;
  private handler: ((cb: LoopbackCallback) => Promise<LoopbackVerdict>) | null = null;
  private readonly server: Server;

  private constructor() {
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
      });
    });
  }

  static start(): Promise<OAuthLoopbackListener> {
    const listener = new OAuthLoopbackListener();
    return new Promise((resolve, reject) => {
      listener.server.once("error", reject);
      listener.server.listen(0, "127.0.0.1", () => {
        const address = listener.server.address();
        if (!address || typeof address === "string") {
          listener.server.close();
          reject(new Error("oauth loopback listener failed to bind"));
          return;
        }
        listener.port = address.port;
        resolve(listener);
      });
    });
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}${CALLBACK_PATH}`;
  }

  // Registered once per flow. Fired for every well-formed (code+state present) hit on
  // /callback; the handler does its own state VALIDATION (matching against the value this
  // flow issued) since only the caller (holding the OAuthClientProvider) knows what state it
  // issued. A request missing code/state is answered 400 directly and never reaches the
  // handler -- it's malformed, not a security-relevant mismatch.
  onCallback(handler: (cb: LoopbackCallback) => Promise<LoopbackVerdict>): void {
    this.handler = handler;
  }

  /** Names the store server on the rendered success page. */
  setServerName(name: string): void {
    this.serverName = name;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      res.writeHead(400, { "content-type": "text/plain" }).end("missing code or state");
      return;
    }
    if (!this.handler) {
      res.writeHead(410, { "content-type": "text/plain" }).end("no oauth flow is waiting for a callback");
      return;
    }
    const { accepted, done } = await this.handler({ code, state });
    const status = accepted ? 200 : 400;
    const body = renderCallbackPage(accepted, this.serverName);
    // `connection: close` + closing the listener only from THIS response's flush callback
    // (never by awaiting server.close() from inside the still-open request that triggered it)
    // avoids a self-deadlock: Node's server.close() callback only fires once every live
    // connection ends, and this request's own connection can't end until its response is
    // written -- awaiting close() before writing would hang forever.
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
    res.end(body, () => {
      if (done) void this.close();
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
