import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";

type Seen = { path: string; headers: http.IncomingHttpHeaders; body: string };
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

async function fixture(status: number, crossOrigin: boolean, token: boolean) {
  const seen: Seen[] = [];
  const leaked: Seen[] = [];
  const record = async (req: http.IncomingMessage): Promise<Seen> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return { path: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() };
  };
  const serve = async (handler: http.RequestListener) => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const other = await serve(async (req, res) => {
    leaked.push(await record(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "synthetic-leak", token_type: "Bearer" }));
  });
  const origin = await serve(async (req, res) => {
    seen.push(await record(req));
    if (req.url === "/start") {
      res.writeHead(status, { location: crossOrigin ? `${other}/receive` : "/receive" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(token ? { access_token: "synthetic-access", token_type: "Bearer" }
      : { jsonrpc: "2.0", id: 1, result: { content: [] } }));
  });
  return { origin, seen, leaked };
}

describe("MCP SDK default redirect boundaries", () => {
  for (const status of [307, 308]) {
    for (const crossOrigin of [false, true]) {
      it(`HTTP ${status}: ${crossOrigin ? "refuses cross-origin" : "preserves same-origin"} sensitive tool requests`, async () => {
        const f = await fixture(status, crossOrigin, false);
        const transport = new StreamableHTTPClientTransport(new URL(`${f.origin}/start`), {
          sessionId: "synthetic-session", requestInit: { headers: { "X-API-Key": "synthetic-api-key" } },
        });
        const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/call", params: { name: "probe", arguments: { text: "synthetic-sensitive-body" } } };
        try {
          await transport.start();
          if (crossOrigin) await expect(transport.send(request)).rejects.toThrow(/redirect.*not followed/i);
          else await transport.send(request);
          expect(f.seen).toHaveLength(crossOrigin ? 1 : 2);
          for (const request of f.seen) {
            expect(request.headers["x-api-key"]).toBe("synthetic-api-key");
            expect(request.headers["mcp-session-id"]).toBe("synthetic-session");
            expect(request.body).toContain("synthetic-sensitive-body");
          }
          expect(f.leaked).toEqual([]);
        } finally { await transport.close(); }
      });

      it(`OAuth ${status}: ${crossOrigin ? "refuses cross-origin" : "preserves same-origin"} refresh credentials`, async () => {
        const f = await fixture(status, crossOrigin, true);
        const request = refreshAuthorization(f.origin, {
          metadata: { issuer: f.origin, authorization_endpoint: `${f.origin}/authorize`, token_endpoint: `${f.origin}/start`,
            response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["client_secret_post"] },
          clientInformation: { client_id: "synthetic-client", client_secret: "synthetic-secret", token_endpoint_auth_method: "client_secret_post" },
          refreshToken: "synthetic-refresh",
        });
        if (crossOrigin) await expect(request).rejects.toThrow(/redirect.*not followed/i);
        else expect(await request).toMatchObject({ access_token: "synthetic-access" });
        expect(f.seen).toHaveLength(crossOrigin ? 1 : 2);
        for (const request of f.seen) {
          expect(request.body).toContain("refresh_token=synthetic-refresh");
          expect(request.body).toContain("client_secret=synthetic-secret");
        }
        expect(f.leaked).toEqual([]);
      });
    }
  }
});
