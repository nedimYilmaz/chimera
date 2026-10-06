import { register } from "tsx/esm/api";
register();
const { ChimeraClient } = await import("../../../client/src/client.ts");
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");

// The pre-fix entrypoint owned neither stdio EOF nor its persistent client. Keep a
// real referenced ChimeraClient socket so closing stdin can reproduce that hang.
if (process.argv[2] === "stuck") {
  await ChimeraClient.connect();
  // Deliberately survive stdin/socket closure to exercise only the harness fallback.
  setInterval(() => {}, 1000);
  process.stderr.write("ready\n");
} else if (process.argv[2] === "legacy") {
  await ChimeraClient.connect();
  const server = new Server({ name: "legacy-lifetime", version: "1" });
  await server.connect(new StdioServerTransport());
} else {
  const { PassThrough } = await import("node:stream");
  const { createMcpLifecycle, STARTUP_INPUT_HIGH_WATER_MARK } = await import("../../src/lifecycle.ts");
  const input = new PassThrough({ highWaterMark: STARTUP_INPUT_HIGH_WATER_MARK });
  const lifecycle = createMcpLifecycle({
    connect: () => ChimeraClient.connect(), stdin: process.stdin, signals: process,
    closeInput: () => { process.stdin.unpipe(input); input.destroy(); process.stdin.pause(); }, onSignal: () => {},
    onError: error => { console.error(error); process.exitCode = 1; },
  });
  const transport = new StdioServerTransport(input);
  lifecycle.bindTransport(transport);
  process.stdin.pipe(input);
  const server = new Server({ name: "explicit-lifetime", version: "1" });
  await server.connect(transport);
  await lifecycle.reconnect();
  // Synthetic test control: explicit protocol close, while the parent keeps stdin open.
  process.stdin.once("data", () => { void server.close(); });
  process.stderr.write("ready\n");
}
