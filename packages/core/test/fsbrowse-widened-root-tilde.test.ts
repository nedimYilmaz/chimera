import { describe, it, expect, vi } from "vitest";

// PATH-LINK-TILDE-AND-SCOPE — proves the full "~/..." path resolves through
// the REAL fs.read RPC end to end, including the OS home-dir expansion that
// fsbrowse.ts's expandHome does via node:os's homedir(). Isolated in its own
// file (mirrors events-noscan.test.ts's vi.mock("node:fs") precedent) so
// mocking node:os's homedir() here can't leak into any other suite that
// happens to touch it (e.g. mcp-imports.ts's homedir()-based default paths).
let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { Engine } = await import("@chimera/core/engine");
const { FakeAgentBackend } = await import("@chimera/core/backends/fake");
const { makeEngineHome } = await import("./helpers.js");

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "chimera-fsbrowse-tilde-"));
}

function engineOn(home: string) {
  return new Engine({ home, backends: new Map([["claude", new FakeAgentBackend([])]]) });
}

describe("fs.read RPC — \"~/...\" against the REAL OS home dir (mocked)", () => {
  it("resolves ~/Documents/acmecorp/report.md when projectImportDir is that exact directory (the reported bug's shape)", async () => {
    fakeHome = makeDir();
    const importDir = join(fakeHome, "Documents", "acmecorp");
    mkdirSync(importDir, { recursive: true });
    writeFileSync(join(importDir, "report.md"), "coh detail");

    const e = engineOn(makeEngineHome());
    await e.handle("config.patch", { patch: { projectImportDir: importDir } });
    const result = await e.handle("fs.read", { path: "~/Documents/acmecorp/report.md" });
    expect(result).toMatchObject({ content: "coh detail", binary: false });
  });

  it("refuses ~/.ssh/id_rsa — tilde expansion never widens to the whole home directory", async () => {
    fakeHome = makeDir();
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    writeFileSync(join(fakeHome, ".ssh", "id_rsa"), "PRIVATE KEY");
    const importDir = join(fakeHome, "Documents", "acmecorp");
    mkdirSync(importDir, { recursive: true });

    const e = engineOn(makeEngineHome());
    await e.handle("config.patch", { patch: { projectImportDir: importDir } });
    await expect(e.handle("fs.read", { path: "~/.ssh/id_rsa" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("refuses ~/.aws/credentials the same way", async () => {
    fakeHome = makeDir();
    mkdirSync(join(fakeHome, ".aws"), { recursive: true });
    writeFileSync(join(fakeHome, ".aws", "credentials"), "[default]\naws_access_key_id=x");
    const importDir = join(fakeHome, "Documents", "acmecorp");
    mkdirSync(importDir, { recursive: true });

    const e = engineOn(makeEngineHome());
    await e.handle("config.patch", { patch: { projectImportDir: importDir } });
    await expect(e.handle("fs.read", { path: "~/.aws/credentials" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("refuses a symlink under projectImportDir that escapes it, reached via a ~-path", async () => {
    fakeHome = makeDir();
    const importDir = join(fakeHome, "Documents", "acmecorp");
    mkdirSync(importDir, { recursive: true });
    const outside = makeDir();
    writeFileSync(join(outside, "secret.txt"), "shh");
    symlinkSync(outside, join(importDir, "escape"));

    const e = engineOn(makeEngineHome());
    await e.handle("config.patch", { patch: { projectImportDir: importDir } });
    await expect(e.handle("fs.read", { path: "~/Documents/acmecorp/escape/secret.txt" })).rejects.toMatchObject({ code: "protocol" });
  });

  it("refuses ~otheruser/... (a different user's home) even if it would lexically land under an allowed root", async () => {
    fakeHome = makeDir();
    const e = engineOn(makeEngineHome());
    await expect(e.handle("fs.read", { path: "~root/etc/passwd" })).rejects.toMatchObject({ code: "protocol" });
  });
});
