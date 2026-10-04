import { describe, it, expect } from "vitest";
import { classifyCredential } from "@chimera/core/credential-classify";

// OAUTH-TOKEN-ACCOUNTS: classifyCredential is the ONE place a pasted Anthropic key's
// prefix shape maps to a credentialType + the env var it must be injected as.
describe("classifyCredential", () => {
  it("classifies a Claude Code OAuth token (sk-ant-oat01...) as oauthToken -> CLAUDE_CODE_OAUTH_TOKEN", () => {
    expect(classifyCredential("claude", "sk-ant-oat01-abc123", "ANTHROPIC_API_KEY")).toEqual({
      credentialType: "oauthToken", injectAs: "CLAUDE_CODE_OAUTH_TOKEN",
    });
  });

  it("classifies an Admin API key (sk-ant-admin...) as adminKey with an explicit warning", () => {
    const result = classifyCredential("claude", "sk-ant-admin-abc123", "ANTHROPIC_API_KEY");
    expect(result.credentialType).toBe("adminKey");
    expect(result.injectAs).toBe("ANTHROPIC_API_KEY");
    expect(result.warning).toMatch(/admin/i);
    expect(result.warning).toMatch(/cannot call the Messages API/i);
  });

  it("classifies a standard API key (sk-ant-api03...) as apiKey -> ANTHROPIC_API_KEY", () => {
    expect(classifyCredential("claude", "sk-ant-api03-abc123", "ANTHROPIC_API_KEY")).toEqual({
      credentialType: "apiKey", injectAs: "ANTHROPIC_API_KEY",
    });
    expect(classifyCredential("claude", "sk-ant-api03-abc123", "ANTHROPIC_API_KEY").warning).toBeUndefined();
  });

  it("classifies any other claude-shaped string as apiKey (no known prefix)", () => {
    expect(classifyCredential("claude", "some-opaque-legacy-key", "ANTHROPIC_API_KEY")).toEqual({
      credentialType: "apiKey", injectAs: "ANTHROPIC_API_KEY",
    });
  });

  it("never applies Anthropic prefix rules to a non-claude provider — always apiKey with the fallback injectAs", () => {
    // even a string that LOOKS like an oauth/admin token must not be reinterpreted for
    // another provider — the prefix convention is Anthropic-specific.
    expect(classifyCredential("xai", "sk-ant-oat01-abc123", "XAI_API_KEY")).toEqual({
      credentialType: "apiKey", injectAs: "XAI_API_KEY",
    });
    expect(classifyCredential("codex", "sk-live-openai-secret", "OPENAI_API_KEY")).toEqual({
      credentialType: "apiKey", injectAs: "OPENAI_API_KEY",
    });
  });
});
