import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SttPreferencesSchema, type SttStatus } from "@chimera/protocol";
import { writeFileDurable } from "./durable-write.js";
import { STT_MODEL, STT_RUNTIME } from "./stt-pins.js";

export type SttExec = (file: string, args: string[], signal: AbortSignal, timeout: number) => Promise<string>;
export const sttExec: SttExec = (file, args, signal, timeout) => new Promise((resolve, reject) => {
  execFile(file, args, { signal, timeout, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } }, (error, stdout) => error ? reject(new Error(`Local speech process failed: ${error.message.split("\n")[0]}`)) : resolve(stdout));
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
async function regular(path: string): Promise<void> { const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink()) throw new Error("Local speech file is not a regular file"); }
export async function sttDigest(path: string): Promise<string> {
  await regular(path); const h = createHash("sha256");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { for await (const chunk of file.createReadStream({ autoClose: false })) h.update(chunk); } finally { await file.close(); }
  return h.digest("hex");
}
async function safeTree(path: string): Promise<void> {
  const s = await lstat(path);
  if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw new Error("Local speech directory contains an unsafe entry");
  if (s.isDirectory()) for (const entry of await readdir(path)) await safeTree(join(path, entry));
}
export function validateSttWav(audio: Buffer): number {
  if (audio.length < 46 || audio.length > 1_920_044 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE" || audio.toString("ascii", 12, 16) !== "fmt " || audio.readUInt32LE(16) !== 16 || audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16000 || audio.readUInt32LE(28) !== 32000 || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16 || audio.toString("ascii", 36, 40) !== "data" || audio.readUInt32LE(40) !== audio.length - 44 || audio.readUInt32LE(4) !== audio.length - 8 || audio.length % 2) throw new Error("Expected bounded 16 kHz mono PCM16 WAV (maximum 60 seconds)");
  return (audio.length - 44) / 32;
}
export class LocalStt {
  private controller?: AbortController;
  private installing?: Promise<void>;
  private installStarting = false;
  private readonly cleanup: Promise<void>;
  private transcription?: { id: string; controller: AbortController; done: Promise<unknown> };
  private installState: SttStatus["install"] = { state: "idle", progress: 0 };
  readonly root: string;
  readonly dir: string;
  private readonly exec: SttExec;
  constructor(private readonly deps: { home: string; exec?: SttExec; fetch?: typeof fetch; platform?: string; runtime?: typeof STT_RUNTIME; model?: typeof STT_MODEL }) {
    this.root = join(deps.home, "stt"); this.dir = join(this.root, STT_RUNTIME.version); this.exec = deps.exec ?? sttExec;
    this.cleanup = this.removeStaleAudio();
    void this.cleanup.catch(() => {});
  }
  private async removeStaleAudio(): Promise<void> {
    try {
      const stat = await lstat(this.root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Local speech storage must not be a symlink");
      for (const name of await readdir(this.root)) if (/^\.audio-[A-Za-z0-9]{6}$/.test(name)) await rm(join(this.root, name), { recursive: true, force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private async prepare(): Promise<void> {
    await this.cleanup;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.root)).isDirectory() || (await lstat(this.root)).isSymbolicLink()) throw new Error("Local speech storage must not be a symlink");
  }
  private async manifest() {
    await safeTree(this.dir);
    await regular(join(this.dir, "whisper-cli")); await regular(join(this.dir, "model.bin"));
    return z.object({ v: z.literal(1), source: z.literal((this.deps.runtime ?? STT_RUNTIME).sha256), model: z.literal((this.deps.model ?? STT_MODEL).sha256), binary: digest }).strict().parse(JSON.parse(await readFile(join(this.dir, "manifest.json"), "utf8")));
  }
  async preferences(): Promise<SttStatus["preferences"]> {
    try { const path = join(this.deps.home, "stt.json"); await regular(path); return SttPreferencesSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, engine: null, language: "en" }; throw new Error("Unsupported or invalid stt.json; it has been preserved"); }
  }
  async configure(preferences: SttStatus["preferences"]) { await this.preferences(); await mkdir(this.deps.home, { recursive: true }); writeFileDurable(join(this.deps.home, "stt.json"), JSON.stringify(preferences)); return preferences; }
  async status(): Promise<SttStatus> {
    await this.cleanup;
    const platform = this.deps.platform ?? `${process.platform}-${process.arch}`;
    const supported = ["darwin-arm64", "linux-x64"].includes(platform);
    let installed = false; let reason = supported ? "Install local speech explicitly; CMake and a C++ compiler are required." : "Whisper local build supports macOS arm64 and Linux x64 only.";
    try { await this.manifest(); installed = true; reason = ""; } catch (error) {
      try { await lstat(this.dir); reason = `Local installation needs repair: ${error instanceof Error ? error.message : "invalid manifest"}`; } catch { /* not installed */ }
    }
    return { preferences: await this.preferences(), engines: [{ id: "whisper-cpp", available: supported, installed, ...(installed ? { version: STT_RUNTIME.version } : {}), languages: ["en", "tr"], ...(reason ? { reason } : {}) }], install: { ...this.installState }, model: { id: STT_MODEL.id, bytes: STT_MODEL.bytes, sha256: STT_MODEL.sha256, license: STT_MODEL.license, runtimeVersion: STT_RUNTIME.version, runtimeSha256: STT_RUNTIME.sha256, path: this.dir } };
  }
  async install(): Promise<SttStatus> {
    if (this.installing || this.installStarting || this.transcription) throw new Error("Local speech is busy");
    this.installStarting = true;
    const controller = this.controller = new AbortController();
    try {
    const status = await this.status(); if (!status.engines[0]!.available) throw new Error(status.engines[0]!.reason);
    await this.prepare();
    // Unknown future storage versions must never be overwritten by an older app.
    try { await lstat(this.dir); await this.manifest(); return status; } catch (error) {
      try { await lstat(this.dir); throw new Error("Existing local installation is invalid; remove it explicitly before reinstalling"); } catch (exists) { if ((exists as NodeJS.ErrnoException).code !== "ENOENT") throw exists; }
    }
    controller.signal.throwIfAborted();
    this.installState = { state: "downloading", progress: 0 };
    this.installing = this.performInstall(controller.signal).catch(error => {
      this.installState = { state: controller.signal.aborted ? "idle" : "failed", progress: 0, ...(controller.signal.aborted ? {} : { error: error instanceof Error ? error.message : String(error) }) };
    }).finally(() => { this.installing = undefined; this.controller = undefined; });
    return this.status();
    } finally { this.installStarting = false; if (!this.installing) this.controller = undefined; }
  }
  async waitForInstall(): Promise<void> { await this.installing; }
  private async download(pin: { url: string; bytes: number; sha256: string }, path: string, signal: AbortSignal, base: number, share: number) {
    if (new URL(pin.url).protocol !== "https:") throw new Error("Speech downloads require HTTPS");
    const timed = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
    timed.throwIfAborted();
    const response = await (this.deps.fetch ?? fetch)(pin.url, { signal: timed });
    if (!response.ok || !response.body || (response.url && new URL(response.url).protocol !== "https:")) throw new Error("Local speech download failed");
    const handle = await open(path, "wx", 0o600); const hash = createHash("sha256"); let bytes = 0;
    try {
      for await (const chunk of response.body) {
        timed.throwIfAborted(); bytes += chunk.length; if (bytes > pin.bytes) throw new Error("Local speech artifact exceeds pinned size");
        hash.update(chunk); await handle.write(chunk); this.installState = { state: "downloading", progress: base + share * bytes / pin.bytes };
      }
      this.installState = { state: "verifying", progress: base + share };
      if (bytes !== pin.bytes || hash.digest("hex") !== pin.sha256) throw new Error("Local speech artifact integrity check failed");
      await handle.sync();
    } finally { await handle.close(); }
  }
  private async performInstall(signal: AbortSignal) {
    const stage = await mkdtemp(join(this.root, ".install-"));
    try {
      // Fail before a model download when the local build tools are absent.
      await this.exec("cmake", ["--version"], signal, 5000);
      const runtime = this.deps.runtime ?? STT_RUNTIME; const model = this.deps.model ?? STT_MODEL;
      await this.download(runtime, join(stage, "runtime.part"), signal, 0, 0.05);
      const names = (await this.exec("tar", ["-tzf", join(stage, "runtime.part")], signal, 10000)).trim().split("\n");
      const types = (await this.exec("tar", ["-tvzf", join(stage, "runtime.part")], signal, 10000)).trim().split("\n");
      if (names.some(n => !n.startsWith(`whisper.cpp-${STT_RUNTIME.version}/`) || n.split("/").includes("..")) || types.some(n => !["-", "d"].includes(n[0]!))) throw new Error("Unsafe local speech archive");
      await this.exec("tar", ["-xzf", join(stage, "runtime.part"), "-C", stage], signal, 10000);
      const source = join(stage, `whisper.cpp-${STT_RUNTIME.version}`); await safeTree(source);
      this.installState = { state: "building", progress: 0.05 };
      await this.exec("cmake", ["-S", source, "-B", join(stage, "build"), "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DGGML_BACKEND_DL=OFF", "-DGGML_METAL=OFF", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF"], signal, 120000);
      await this.exec("cmake", ["--build", join(stage, "build"), "--config", "Release", "--target", "whisper-cli", "-j", "2"], signal, 300000);
      const ready = join(stage, "ready"); await mkdir(ready, { mode: 0o700 });
      await rename(join(stage, "build", "bin", "whisper-cli"), join(ready, "whisper-cli")); await chmod(join(ready, "whisper-cli"), 0o700);
      await this.download(model, join(ready, "model.part"), signal, 0.1, 0.9);
      await rename(join(ready, "model.part"), join(ready, "model.bin"));
      signal.throwIfAborted();
      writeFileDurable(join(ready, "manifest.json"), JSON.stringify({ v: 1, source: runtime.sha256, model: model.sha256, binary: await sttDigest(join(ready, "whisper-cli")) }));
      await rename(ready, this.dir); this.installState = { state: "installed", progress: 1 };
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  async cancelInstall(): Promise<{ cancelled: boolean }> { const cancelled = !!this.controller; this.controller?.abort(); await this.installing; return { cancelled }; }
  async uninstall(): Promise<{ removed: boolean }> { if (this.transcription) throw new Error("Local speech is transcribing; cancel it before removing"); await this.cancelInstall(); await this.prepare(); await rm(this.dir, { recursive: true, force: true }); this.installState = { state: "idle", progress: 0 }; return { removed: true }; }
  cancelTranscribe(id: string): { cancelled: boolean } { const cancelled = this.transcription?.id === id; if (cancelled) this.transcription!.controller.abort(); return { cancelled }; }
  async transcribe(id: string, language: "en" | "tr", base64: string) {
    if (this.transcription || this.installing || this.installStarting) throw new Error("Local speech is busy");
    const controller = new AbortController();
    const done = this.runTranscribe(language, base64, controller.signal);
    this.transcription = { id, controller, done };
    try { return await done; } finally { this.transcription = undefined; }
  }
  private async runTranscribe(language: "en" | "tr", base64: string, signal: AbortSignal) {
    const audio = Buffer.from(base64, "base64"); if (audio.toString("base64") !== base64) throw new Error("Invalid audio encoding");
    const durationMs = validateSttWav(audio); const m = await this.manifest();
    if (await sttDigest(join(this.dir, "whisper-cli")) !== m.binary || await sttDigest(join(this.dir, "model.bin")) !== m.model) throw new Error("Local speech integrity check failed; remove and reinstall");
    await this.prepare(); const temp = await mkdtemp(join(this.root, ".audio-"));
    try {
      signal.throwIfAborted(); const path = join(temp, "capture.wav"); const file = await open(path, "wx", 0o600); try { await file.writeFile(audio); } finally { await file.close(); }
      const text = (await this.exec(join(this.dir, "whisper-cli"), ["-m", join(this.dir, "model.bin"), "-f", path, "-l", language, "-nt", "-np", "-t", "2"], signal, 25000)).trim();
      signal.throwIfAborted(); if (!text || text.length > 8192) throw new Error("Local speech returned no bounded transcript");
      return { text, language, durationMs, engine: "whisper-cpp" as const };
    } finally { audio.fill(0); await rm(temp, { recursive: true, force: true }); }
  }
}
