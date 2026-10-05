import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LocalStt, sttDigest, validateSttWav, type SttExec } from "../src/stt.js";
import { STT_MODEL, STT_RUNTIME } from "../src/stt-pins.js";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(h => rm(h, { recursive: true, force: true }))); });
const audio = () => readFile(new URL("./fixtures/stt/tr.wav", import.meta.url));
async function prepared(exec: SttExec) {
  const h = await mkdtemp(join(tmpdir(), "chimera-stt-test-")); homes.push(h); const dir = join(h, "stt", STT_RUNTIME.version); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "whisper-cli"), "fixture executable"); await writeFile(join(dir, "model.bin"), "model");
  const model = { ...STT_MODEL, bytes: 5, sha256: createHash("sha256").update("model").digest("hex") };
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ v: 1, source: STT_RUNTIME.sha256, model: model.sha256, binary: await sttDigest(join(dir, "whisper-cli")) }));
  return { stt: new LocalStt({ home: h, model, exec }), h, dir };
}
describe("bounded private local transcription", () => {
  it("rejects malformed/oversized/nonmono WAV", async () => {
    const wav = await audio(); expect(validateSttWav(wav)).toBeGreaterThan(1000);
    for (const changed of [Buffer.alloc(1_920_046), Buffer.from(wav), Buffer.from(wav)]) { if (changed.length === wav.length) changed.writeUInt16LE(2, 22); expect(() => validateSttWav(changed)).toThrow("bounded"); }
  });
  it("uses args, fixed installed paths and cleans its private audio directory", async () => {
    let checked = false;
    const { stt, h, dir } = await prepared(async (file, args, _signal, timeout) => {
      expect(file).toBe(join(dir, "whisper-cli")); expect(args.slice(0, 2)).toEqual(["-m", join(dir, "model.bin")]); expect(args).toContain("tr"); expect(timeout).toBe(25000);
      expect(validateSttWav(await readFile(args[3]!))).toBeGreaterThan(1000); checked = true; return "Merhaba dünya";
    });
    const result = await stt.transcribe("request", "tr", (await audio()).toString("base64")); expect(result.text).toBe("Merhaba dünya"); expect(checked).toBe(true); expect(await readdir(join(h, "stt"))).toEqual([STT_RUNTIME.version]);
  });
  it("cancels the actual process seam and deletes audio on errors", async () => {
    let running!: () => void; const ready = new Promise<void>(r => { running = r; });
    const { stt, h } = await prepared(async (_f, _a, signal) => { running(); return new Promise((_r, reject) => signal.addEventListener("abort", () => reject(Error("cancelled")))); });
    const pending = stt.transcribe("request", "en", (await audio()).toString("base64")); const assertion = expect(pending).rejects.toThrow("cancelled"); await ready;
    expect(stt.cancelTranscribe("other").cancelled).toBe(false); expect(stt.cancelTranscribe("request").cancelled).toBe(true); await assertion;
    expect(await readdir(join(h, "stt"))).toEqual([STT_RUNTIME.version]);
  });
  it("never executes a modified binary or model or a symlink", async () => {
    const exec = vi.fn(async () => "fake"); const { stt, dir } = await prepared(exec);
    await writeFile(join(dir, "model.bin"), "tampered"); await expect(stt.transcribe("request", "en", (await audio()).toString("base64"))).rejects.toThrow("integrity"); expect(exec).not.toHaveBeenCalled();
    await rm(join(dir, "model.bin")); await symlink(join(dir, "whisper-cli"), join(dir, "model.bin")); await expect(stt.transcribe("request", "en", (await audio()).toString("base64"))).rejects.toThrow("unsafe");
  });
});
