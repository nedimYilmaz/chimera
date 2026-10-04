import { describe, it, expect, vi } from "vitest";
import { validateCodexModel } from "@chimera/core/providers/codex-cli-models";

const model = { slug: "future-model", supports_search_tool: true, supported_reasoning_levels: [{ effort: "high" }], input_modalities: ["text", "image"] };
describe("Codex CLI model capability validation", () => {
  it.each([undefined, null, "", "   ", 42])("rejects a missing or malformed model (%s) before probing the CLI", async (value) => {
    const exec = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ models: [model] }) }));
    await expect(validateCodexModel(value as string, undefined, false, {}, exec)).rejects.toThrow(/Codex model must be a non-empty string/);
    expect(exec).not.toHaveBeenCalled();
  });
  it("accepts newly advertised models using the selected binary and account environment", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ models: [model] }) }));
    const env = { CHIMERA_CODEX_CLI_PATH: process.execPath, CODEX_HOME: "/account" };
    await validateCodexModel("future-model", "high", true, env, exec);
    expect(exec).toHaveBeenCalledWith(process.execPath, ["debug", "models"], env);
  });
  it.each([
    [{ ...model, supports_search_tool: false }, "high", false, /tool search/],
    [model, "ultra", false, /reasoning effort/],
    [{ ...model, input_modalities: ["text"] }, "high", true, /image input/],
  ] as const)("rejects unsupported capabilities", async (entry, effort, image, error) => {
    await expect(validateCodexModel("future-model", effort, image, {}, async () => ({ code: 0, stdout: JSON.stringify({ models: [entry] }) }))).rejects.toThrow(error);
  });
  it("fails closed if discovery fails", async () => {
    await expect(validateCodexModel("future-model", undefined, false, {}, async () => ({ code: 1, stdout: "" }))).rejects.toThrow(/unavailable/);
  });
});


it("reads context capacities from the selected CLI/account without a model-name table", async () => {
  const exec = vi.fn(async () => ({ code: 0, stdout: JSON.stringify({ models: [{ ...model, context_window: 333333, max_context_window: 1444444 }] }) }));
  expect(await validateCodexModel("future-model", "high", false, { CODEX_HOME: "/other-account" }, exec)).toEqual({ source: "codex", defaultWindow: 333333, maxWindow: 1444444 });
  const missing = async () => ({ code: 0, stdout: JSON.stringify({ models: [{ ...model, context_window: -1, max_context_window: "1000000" }] }) });
  expect(await validateCodexModel("future-model", "high", false, {}, missing)).toEqual({ source: "codex" });
});
