/** Opt-in live smoke: local fixture only; no real agents, accounts, mail or desktop mutations. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createChimeraMcpServer } from "../../protocol/src/mcp-server-factory.js";
import { McpStoreRegistry, McpStoreConnectionManager } from "../src/mcpstore.js";
import { InMemoryKeychain } from "../src/keychain.js";
import { computerUseEntries } from "../src/computer-use.js";

const { values } = parseArgs({ options: { "laya-python": { type: "string" }, "playwright-cli": { type: "string" }, "browser-executable": { type: "string" } } });
assert(values["laya-python"] && values["playwright-cli"], "Pass --laya-python and --playwright-cli");
const home = await mkdtemp(join(tmpdir(), "chimera-computer-smoke-"));
const registry = new McpStoreRegistry(home);
for (const entry of computerUseEntries({ home, node: process.execPath, layaPython: values["laya-python"], playwrightCli: values["playwright-cli"], browserExecutable: values["browser-executable"] })) registry.add(entry);
const manager = new McpStoreConnectionManager(registry, new InMemoryKeychain());
const page = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end('<!doctype html><title>Chimera Computer Use test</title><button onclick="this.textContent=\'Test completed\'">Complete test</button>'); });
await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(page.address() as { port: number }).port}/`;
const clients: Client[] = [];
const servers: Awaited<ReturnType<typeof createChimeraMcpServer>>[] = [];
try {
  for (const agentId of ["claude-smoke", "codex-smoke"]) {
    const server = await createChimeraMcpServer(async (method, p: any) => {
      if (method === "mcpstore.list") return registry.list();
      if (method === "mcpstore.tools") return { servers: await manager.tools(p.query, p.servers) };
      if (method === "mcpstore.call") return manager.call(p.server, p.tool, p.args, undefined, p.agentId);
      if (method === "mcpstore.session") return manager.session(p.server, p.action, p.agentId);
      throw new Error(`Unexpected method ${method}`);
    }, { depth: 0, agentId });
    const client = new Client({ name: agentId, version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b); clients.push(client); servers.push(server);
  }
  const run = async (client: Client, server: string, tool: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: "mcp_store_call", arguments: { server, tool, args } }, undefined, { timeout: 150_000 });
    assert.notEqual(result.isError, true, JSON.stringify(result.content).slice(0, 1000));
    return result;
  };
  const text = (result: any) => JSON.parse(result.content.find((b: any) => b.type === "text").text).text as string;
  await run(clients[0]!, "chimera-browser", "browser_navigate", { url });
  const observed = text(await run(clients[0]!, "chimera-browser", "browser_snapshot"));
  const ref = observed.match(/button "Complete test" \[ref=([^\]]+)\]/)?.[1];
  assert(ref, "Observed button ref is present: " + observed);
  const decisionResult = await run(clients[0]!, "laya", "laya_predict", {
    state: { text: "The user asked to press the Complete test button once. Browser observation:\n" + observed },
    questions: { action: { type: "choice", instructions: "Select the next action that completes the user's task.", criteria: { click: "Click the Complete test button", close: "Close the browser", wait: "Do nothing" } } },
  });
  const structured = decisionResult.structuredContent as Record<string, any> | undefined;
  const decision = structured?.answers ? structured : typeof structured?.result === "string" ? JSON.parse(structured.result)
    : JSON.parse(text(decisionResult).split("\nStructured result:")[0]!.match(/\{[\s\S]*\}/)![0]);
  assert.equal(decision.answers.action.choice, "click");
  await run(clients[0]!, "chimera-browser", "browser_click", { element: "Complete test", target: ref });
  const after = text(await run(clients[0]!, "chimera-browser", "browser_snapshot"));
  assert(after.includes("Test completed"), "Action outcome is visible");
  const shot = await run(clients[0]!, "chimera-browser", "browser_take_screenshot", { type: "png" });
  assert((shot.content as any[]).some(b => b.type === "image" && b.data.length > 100), "Screenshot reaches the agent as real MCP image data");
  const other = text(await run(clients[1]!, "chimera-browser", "browser_tabs", { action: "list" }));
  assert(!other.includes(url) && !other.includes("Chimera Computer Use test"), "Other agent cannot see the first browser's tab");
  await run(clients[1]!, "chimera-browser", "browser_navigate", { url });
  const second = text(await run(clients[1]!, "chimera-browser", "browser_snapshot"));
  assert(second.includes('button "Complete test"') && !second.includes('button "Test completed"'), "Second browser starts independently");
  console.log("PASS: real Laya decision → observed browser click → verified result → native MCP screenshot; Claude/Codex principals have isolated browser sessions.");
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  await Promise.allSettled(servers.map(server => server.close()));
  await manager.closeAll();
  await new Promise<void>(resolve => page.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
}
