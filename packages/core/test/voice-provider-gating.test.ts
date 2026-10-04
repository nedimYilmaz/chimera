import { describe, expect, it } from "vitest";
import { ClaudeAgentBackend } from "@chimera/core/backends/claude";
import { CodexAgentBackend } from "@chimera/core/backends/codex";
import { findProvider } from "@chimera/core/providers/catalog";

describe("voice provider gating", () => {
  it("advertises native Codex voice without claiming native Claude voice", () => {
    const backends = {
      claude: new ClaudeAgentBackend(),
      codex: new CodexAgentBackend(),
    };

    for (const [provider, backend] of Object.entries(backends)) {
      expect(findProvider(provider)?.capabilities.realtime).toBe(provider === "codex");
      expect(backend.capabilities.supportsVoiceRealtime).toBe(provider === "codex");
    }
  });
});
