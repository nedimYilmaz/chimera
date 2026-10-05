import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStt, type SttExec } from "../src/stt.js";
import { STT_MODEL, STT_RUNTIME } from "../src/stt-pins.js";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(h => rm(h, { recursive: true, force: true }))); });
async function home() { const h = await mkdtemp(join(tmpdir(), "chimera-stt-test-")); homes.push(h); return h; }
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const runtime = { ...STT_RUNTIME, bytes: 6, sha256: sha("source") };
const model = { ...STT_MODEL, bytes: 5, sha256: sha("model") };
const download = (async (url: string) => new Response(url.includes("huggingface") ? "model" : "source")) as typeof fetch;
function builder(unsafe = false): SttExec {
  return async (file, args) => {
    if (file === "tar" && args[0] === "-tzf") return unsafe ? "../../evil" : `whisper.cpp-${STT_RUNTIME.version}/CMakeLists.txt`;
    if (file === "tar" && args[0] === "-tvzf") return "-rw------- file";
    if (file === "tar" && args[0] === "-xzf") await mkdir(join(args[3]!, `whisper.cpp-${STT_RUNTIME.version}`));
    if (file === "cmake" && args[0] === "--build") { await mkdir(join(args[1]!, "bin"), { recursive: true }); await writeFile(join(args[1]!, "bin", "whisper-cli"), "test binary"); }
    return "";
  };
}
describe("optional pinned local speech install", () => {
  it("does not fetch or run anything when reading status", async () => {
    const stt = new LocalStt({ home: await home(), fetch: () => { throw Error("network called"); }, exec: () => { throw Error("process called"); }, platform: "win32-x64" });
    const status = await stt.status(); expect(status.engines[0]).toMatchObject({ available: false, installed: false });
  });
  it("verifies artifacts, builds locally, atomically installs and explicitly removes", async () => {
    const h = await home(); const stt = new LocalStt({ home: h, fetch: download, exec: builder(), runtime, model });
    await stt.install(); await stt.waitForInstall(); expect((await stt.status()).engines[0]!.installed).toBe(true);
    expect(await readdir(join(h, "stt"))).toEqual([STT_RUNTIME.version]);
    await stt.uninstall(); expect((await stt.status()).engines[0]!.installed).toBe(false);
  });
  it("rejects a tampered artifact and cleans partial files before retry", async () => {
    const h = await home(); const stt = new LocalStt({ home: h, fetch: (async () => new Response("bad")) as typeof fetch, exec: builder(), runtime, model });
    await stt.install(); await stt.waitForInstall(); expect((await stt.status()).install).toMatchObject({ state: "failed", error: expect.stringContaining("integrity") });
    expect(await readdir(join(h, "stt"))).toEqual([]);
  });
  it("rejects archive traversal without extracting it", async () => {
    const stt = new LocalStt({ home: await home(), fetch: download, exec: builder(true), runtime, model });
    await stt.install(); await stt.waitForInstall(); expect((await stt.status()).install.error).toContain("Unsafe");
  });
  it("cancels a download, clears partial files and admits an explicit retry", async () => {
    const h = await home(); let called!: () => void; const started = new Promise<void>(r => { called = r; });
    const stt = new LocalStt({ home: h, exec: builder(), fetch: ((_url, options) => { called(); return new Promise((_r, reject) => options!.signal!.addEventListener("abort", () => reject(Error("aborted")))); }) as typeof fetch });
    await stt.install(); await started; expect(await stt.cancelInstall()).toEqual({ cancelled: true });
    expect((await stt.status()).install.state).toBe("idle"); expect(await readdir(join(h, "stt"))).toEqual([]);
    await stt.install(); await stt.cancelInstall();
  });
  it("cleans crash-left private audio on startup without touching unrelated directories", async () => {
    const h = await home(); await mkdir(join(h, "stt", ".audio-ABC123"), { recursive: true }); await writeFile(join(h, "stt", ".audio-ABC123", "capture.wav"), "private"); await mkdir(join(h, "stt", "notes"));
    const stt = new LocalStt({ home: h }); await stt.status(); expect(await readdir(join(h, "stt"))).toEqual(["notes"]);
  });
  it("rejects missing build tools before any network request", async () => {
    const stt = new LocalStt({ home: await home(), exec: async () => { throw Error("cmake ENOENT"); }, fetch: () => { throw Error("network must not run"); } });
    await stt.install(); await stt.waitForInstall(); expect((await stt.status()).install.error).toBe("cmake ENOENT");
  });
  it("preserves unknown future preference versions", async () => {
    const h = await home(); await writeFile(join(h, "stt.json"), '{"v":2}'); const stt = new LocalStt({ home: h });
    await expect(stt.configure({ v: 1, engine: null, language: "tr" })).rejects.toThrow("preserved");
  });
});
