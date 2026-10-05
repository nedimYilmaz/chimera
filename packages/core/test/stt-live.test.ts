import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStt } from "../src/stt.js";
import { createHash } from "node:crypto";
import { STT_MODEL, STT_RUNTIME } from "../src/stt-pins.js";
import { performance } from "node:perf_hooks";
const live = process.env.CHIMERA_STT_LIVE === "1";
it.skipIf(!live)("installs pinned upstream artifacts and transcribes deterministic English/Turkish audio locally", async () => {
  const home = await mkdtemp(join(tmpdir(), "chimera-stt-live-")); const stt = new LocalStt({ home });
  const measurements: unknown[] = [];
  try {
    await stt.install(); await stt.waitForInstall(); const status = await stt.status(); expect(status.install.error).toBeUndefined(); expect(status.engines[0]!.installed).toBe(true);
    const manifest = JSON.parse(await readFile(new URL("./fixtures/stt/manifest.json", import.meta.url), "utf8"));
    for (const fixture of manifest.fixtures) {
      const wav = await readFile(new URL(`./fixtures/stt/${fixture.language}.wav`, import.meta.url));
      expect(createHash("sha256").update(wav).digest("hex")).toBe(fixture.sha256);
      const started = performance.now(); const result = await stt.transcribe(crypto.randomUUID(), fixture.language, wav.toString("base64")); const latencyMs = performance.now() - started;
      const words = (text: string) => text.toLocaleLowerCase(fixture.language).replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/);
      const expected = words(fixture.text); const actual = words(result.text);
      const rows = Array.from({ length: expected.length + 1 }, (_v, i) => [i]); for (let j = 1; j <= actual.length; j++) rows[0]![j] = j;
      for (let i = 1; i <= expected.length; i++) for (let j = 1; j <= actual.length; j++) rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + (expected[i - 1] === actual[j - 1] ? 0 : 1));
      const wer = rows[expected.length]![actual.length]! / expected.length;
      measurements.push({ language: fixture.language, fixtureSha256: fixture.sha256, text: result.text, reference: fixture.text, wer, latencyMs, durationMs: result.durationMs });
      expect(wer).toBeLessThanOrEqual(0.1); expect(latencyMs).toBeLessThan(25000);
    }
    if (process.env.CHIMERA_STT_EVIDENCE) await writeFile(process.env.CHIMERA_STT_EVIDENCE, JSON.stringify({ platform: `${process.platform}-${process.arch}`, runtimeSourceSha256: STT_RUNTIME.sha256, modelSha256: STT_MODEL.sha256, measurements }, null, 2));
    await stt.uninstall(); expect((await stt.status()).engines[0]!.installed).toBe(false);
  } finally { await rm(home, { recursive: true, force: true }); }
}, 600000);
