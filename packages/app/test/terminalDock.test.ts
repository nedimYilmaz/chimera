import { describe, it, expect, vi } from "vitest";

// TerminalDock (via its store.ts import) transitively reaches the Tauri rpc/bridge module,
// which fires real listen()/invoke() calls as an import-time DEV side effect (same problem
// TranscriptPanel.test.tsx / TaskInspector.test.tsx hit) — stub it, and the bare window/document
// this node-env config doesn't provide, before importing anything store-adjacent.
if (typeof window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {}, removeEventListener: () => {} };
}
if (typeof document === "undefined") {
  (globalThis as unknown as { document: Record<string, unknown> }).document = {
    createElement: (tag: string) => ({ tagName: tag.toUpperCase(), className: "" }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

vi.mock("../src/rpc/bridge", () => ({
  rpcCall: vi.fn(async () => []),
  subscribeEvents: vi.fn(async () => {}),
  onDaemonEvent: vi.fn(() => () => {}),
  onDaemonState: vi.fn(() => () => {}),
  daemonStatus: vi.fn(async () => "connected"),
}));

const { isEditableTarget } = await import("../src/keymap");
const { shouldSuppressGlobalKeys } = await import("../src/components/TerminalDock");

describe("keyboard ownership", () => {
  it("suppresses global shortcuts while a terminal owns focus", () => {
    expect(shouldSuppressGlobalKeys({ terminalFocused: true, action: "agents.kill" })).toBe(true);
  });
  it("never suppresses the dock toggle", () => {
    expect(shouldSuppressGlobalKeys({ terminalFocused: true, action: "terminal.toggle" })).toBe(false);
  });
  it("does not suppress anything when the terminal is unfocused", () => {
    expect(shouldSuppressGlobalKeys({ terminalFocused: false, action: "agents.kill" })).toBe(false);
  });
  it("treats the xterm textarea as an editable target", () => {
    const ta = document.createElement("textarea");
    (ta as unknown as { className: string }).className = "xterm-helper-textarea";
    expect(isEditableTarget(ta)).toBe(true);
  });
});
