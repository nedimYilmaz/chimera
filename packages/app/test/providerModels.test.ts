import { describe, it, expect } from "vitest";
import { preferredProviderModel } from "../src/state/providerModels";

describe("preferredProviderModel", () => {
  it("picks the newest Claude flagship by numeric version, not lexical order", () => {
    expect(preferredProviderModel("claude", ["claude-opus-4-8", "claude-opus-4-10", "claude-sonnet-5"], "fallback")).toBe("claude-opus-4-10");
  });

  it("falls back to the first advertised model when no flagship is advertised", () => {
    expect(preferredProviderModel("claude", ["claude-sonnet-5", "claude-haiku-4"], "fallback")).toBe("claude-sonnet-5");
  });

  it("falls back to the supplied default when the account advertises no models", () => {
    expect(preferredProviderModel("claude", [], "claude-default")).toBe("claude-default");
  });
});
