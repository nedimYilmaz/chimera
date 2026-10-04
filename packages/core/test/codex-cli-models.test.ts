import { describe, it, expect } from "vitest";
import { resolveCodexBinary, fetchCodexCliModels, type CodexModelsExecFn } from "@chimera/core/providers/codex-cli-models";

const CATALOG_JSON = JSON.stringify({
  models: [
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", description: "Latest frontier agentic coding model.", visibility: "list", priority: 1 },
    { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", description: "Balanced.", visibility: "list", priority: 2 },
    { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 3 },
    { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 7 },
    { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "hide", priority: 16 },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43 },
  ],
});

describe("fetchCodexCliModels", () => {
  it("shells out to `codex debug models`, keeps only visibility:\"list\", sorted by priority", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: CodexModelsExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: CATALOG_JSON, code: 0 };
    };
    const models = await fetchCodexCliModels({ exec });
    // CODEX-MODELS-PATH-DEPENDENT: no longer a bare "codex" (which resolved off the daemon's
    // PATH — empty of nvm under a GUI launch). Whatever resolveCodexBinary picks, the probe must
    // invoke THAT path with these args.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(resolveCodexBinary());
    expect(calls[0]!.args).toEqual(["debug", "models"]);
    expect(models).toEqual([
      { value: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Latest frontier agentic coding model." },
      { value: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", description: "Balanced." },
      { value: "gpt-5.6-luna", displayName: "GPT-5.6-Luna" },
      { value: "gpt-5.5", displayName: "GPT-5.5" },
    ]);
  });

  it("forwards the given env (e.g. CODEX_HOME) to the exec call", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const exec: CodexModelsExecFn = async (_cmd, _args, env) => {
      seenEnv = env;
      return { stdout: CATALOG_JSON, code: 0 };
    };
    await fetchCodexCliModels({ exec, env: { CODEX_HOME: "/tmp/fake-codex-home" } });
    expect(seenEnv?.CODEX_HOME).toBe("/tmp/fake-codex-home");
  });

  it("returns null when the binary is missing / exits non-zero", async () => {
    const exec: CodexModelsExecFn = async () => ({ stdout: "", code: 1 });
    expect(await fetchCodexCliModels({ exec })).toBeNull();
  });

  it("returns null on malformed JSON instead of throwing", async () => {
    const exec: CodexModelsExecFn = async () => ({ stdout: "not json", code: 0 });
    expect(await fetchCodexCliModels({ exec })).toBeNull();
  });

  it("returns null when every model is hidden (no visibility:\"list\" entries)", async () => {
    const exec: CodexModelsExecFn = async () => ({
      stdout: JSON.stringify({ models: [{ slug: "codex-auto-review", visibility: "hide" }] }),
      code: 0,
    });
    expect(await fetchCodexCliModels({ exec })).toBeNull();
  });

  it("returns null when exec itself throws", async () => {
    const exec: CodexModelsExecFn = async () => { throw new Error("ENOENT"); };
    expect(await fetchCodexCliModels({ exec })).toBeNull();
  });
});
