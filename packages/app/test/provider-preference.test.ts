import { it, expect } from "vitest";
import { initialProviderFor } from "../src/state/selectors.settings";

it("suggests Codex for new connections, honoring catalog availability and explicit preference", () => {
  expect(initialProviderFor(["claude", "codex", "openai"])).toBe("codex");
  expect(initialProviderFor(["claude", "codex", "openai"], "openai")).toBe("openai");
  expect(initialProviderFor(["claude", "openai"], "missing")).toBe("openai");
  expect(initialProviderFor(["claude"])).toBe("claude");
});
