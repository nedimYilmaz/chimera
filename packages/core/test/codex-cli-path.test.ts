import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCodexBinary } from "@chimera/core/providers/codex-cli-path";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "chimera-codex-path-"));
  directories.push(home);
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const install = (directory: string) => {
    const path = join(home, directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "", { mode: 0o755 });
    return path;
  };
  return { home, install, execPath: join(home, "node", "node"), env: { HOME: home, PATH: "" } };
}

describe("Codex executable discovery", () => {
  it("preserves a working explicit override ahead of other installations", () => {
    const f = fixture();
    const override = f.install("override");
    f.install("node");
    expect(resolveCodexBinary({ ...f.env, CHIMERA_CODEX_CLI_PATH: override }, f.execPath)).toBe(override);
  });

  it("recovers a removed npm override using the standalone installation under a GUI PATH", () => {
    const f = fixture();
    const standalone = f.install(".local/bin");
    expect(resolveCodexBinary({ ...f.env, CHIMERA_CODEX_CLI_PATH: join(f.home, "old-node/bin/codex") }, f.execPath)).toBe(standalone);
  });

  it("finds the CLI beside node before PATH, and PATH before the standalone fallback", () => {
    const f = fixture();
    const sibling = f.install("node");
    const onPath = f.install("custom-bin");
    f.install(".local/bin");
    const env = { ...f.env, PATH: dirname(onPath) };
    expect(resolveCodexBinary(env, f.execPath)).toBe(sibling);
    rmSync(sibling);
    expect(resolveCodexBinary(env, f.execPath)).toBe(onPath);
  });

  it.skipIf(process.platform === "win32")("skips broken symlinks and non-executable overrides", () => {
    const f = fixture();
    const standalone = f.install(".local/bin");
    const broken = join(f.home, "broken-codex");
    symlinkSync(join(f.home, "removed"), broken);
    expect(resolveCodexBinary({ ...f.env, CHIMERA_CODEX_CLI_PATH: broken }, f.execPath)).toBe(standalone);
    const disabled = f.install("disabled");
    chmodSync(disabled, 0o644);
    expect(resolveCodexBinary({ ...f.env, CHIMERA_CODEX_CLI_PATH: disabled }, f.execPath)).toBe(standalone);
  });
});
