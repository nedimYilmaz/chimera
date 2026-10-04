import { describe, it, expect } from "vitest";
import { mcpImportableRowView, sanitizeMcpStoreImportName } from "../src/state/selectors.settings";
import type { McpStoreImportable } from "@chimera/protocol";

const http = (over: Partial<McpStoreImportable> = {}): McpStoreImportable =>
  ({ source: "claude", name: "context7", type: "http", url: "https://mcp.context7.com/mcp", headers: {}, requiresAuth: true, ...over }) as McpStoreImportable;
const stdio = (over: Partial<McpStoreImportable> = {}): McpStoreImportable =>
  ({ source: "claude", name: "seq", command: "npx", args: ["-y", "server-seq"], env: {} , ...over }) as McpStoreImportable;

describe("mcp importable row — installed detection across the import rename", () => {
  // THE BUG: mcpstore.import sanitizes the name it stores ("Mintlify" -> "mintlify"), but this
  // view model compared the RAW name against the store. A renamed server therefore never showed
  // as installed, its import button stayed live, and clicking it silently overwrote the entry.
  it("matches an installed server whose store name was sanitized on import", () => {
    const row = mcpImportableRowView(http({ name: "Mintlify" }), [{ name: "mintlify" }]);
    expect(row.alreadyInstalled).toBe(true);
    expect(row.disabled).toBe(true);
    expect(row.storeName).toBe("mintlify");
  });

  it("still matches when no rename is involved", () => {
    expect(mcpImportableRowView(http(), [{ name: "context7" }]).alreadyInstalled).toBe(true);
  });

  it("does not claim installed for a name that merely looks similar", () => {
    expect(mcpImportableRowView(http({ name: "context7" }), [{ name: "context7-dev" }]).alreadyInstalled).toBe(false);
  });

  it("agrees with the sanitizer that mirrors core's own", () => {
    for (const n of ["Mintlify", "openaiDeveloperDocs", "already-fine"])
      expect(mcpImportableRowView(http({ name: n }), []).storeName).toBe(sanitizeMcpStoreImportName(n));
  });
});

describe("mcp importable row — transport and endpoint", () => {
  // The redesign's premise: one endpoint column that both transports fill, so a row is never
  // half-empty and the transport is stated rather than inferred from which column is blank.
  it("an http row reports its url as the endpoint", () => {
    const row = mcpImportableRowView(http(), []);
    expect(row.transport).toBe("http");
    expect(row.detail).toBe("https://mcp.context7.com/mcp");
  });

  it("a stdio row reports command AND args as one endpoint string", () => {
    const row = mcpImportableRowView(stdio(), []);
    expect(row.transport).toBe("stdio");
    expect(row.detail).toBe("npx -y server-seq");
  });

  it("an http importable is NOT disabled — remote import is supported", () => {
    // Regression pin for the operator-reported "can't import http servers": the backend has
    // supported it since MCP-REMOTE-IMPORT slice 2, so nothing in this view model may block it.
    const row = mcpImportableRowView(http(), []);
    expect(row.disabled).toBe(false);
    expect(row.needsAuth).toBe(true);
  });

  it("a claude.ai-managed row stays out of the plain-import path but keeps its url", () => {
    const row = mcpImportableRowView(http({ name: "slack", url: "https://mcp.slack.com/mcp", notImportableReason: "not importable (claude.ai-managed auth)" }), []);
    expect(row.claudeAiManaged).toBe(true);
    expect(row.detail).toBe("https://mcp.slack.com/mcp");
  });
});
