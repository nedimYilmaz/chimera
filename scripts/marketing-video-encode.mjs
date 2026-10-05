// Encoders and probes for the usage-video pipeline (scripts/marketing-video.mjs).
//
// What a stock machine can actually do (checked, not assumed):
//   - ffmpeg: none on PATH. Playwright ships a static ffmpeg (~/Library/Caches/ms-playwright/ffmpeg-*)
//     with the libvpx (VP8) encoder, the mjpeg decoder, the image2pipe demuxer and the PNG encoder -
//     and NO png decoder, rawvideo, framemd5, mjpeg encoder or libx264. So frames go in as JPEG,
//     WebM/VP8 comes out, and "decoded frame hashes" come from decoding back to a PNG sequence.
//   - ffprobe: absent everywhere. Nothing here claims to be ffprobe; `probeWithFfmpeg` reads the
//     banner `ffmpeg -i` prints and says so.
//   - H.264 MP4: only via macOS AVFoundation (scripts/marketing-video-mp4.swift). It is reported
//     as supported only when the same tool decodes it back; the verify script additionally plays it in a
//     real browser. Elsewhere the MP4 is skipped and WebM is the deliverable.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SWIFT_SOURCE = fileURLToPath(new URL("./marketing-video-mp4.swift", import.meta.url));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** FFMPEG env var, then PATH, then the Playwright cache. Returns null (never throws) so the caller can
 * degrade with a clear message instead of a stack trace. */
export function resolveFfmpeg(environment = process.env) {
  if (environment.FFMPEG && existsSync(environment.FFMPEG)) return environment.FFMPEG;
  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { encoding: "utf8" });
  if (onPath.status === 0) {
    const found = onPath.stdout.split(/\r?\n/).find(Boolean);
    if (found) return found;
  }
  const cacheRoots = [
    environment.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), "Library/Caches/ms-playwright"),
    join(homedir(), ".cache/ms-playwright"),
    join(environment.LOCALAPPDATA ?? "", "ms-playwright"),
  ].filter(Boolean);
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).filter((name) => name.startsWith("ffmpeg")).sort().reverse()) {
      for (const binary of ["ffmpeg-mac", "ffmpeg-linux", "ffmpeg-win64.exe", "ffmpeg"]) {
        const candidate = join(root, dir, binary);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function run(command, args, { input, signal } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    child.once("error", rejectRun);
    child.once("close", (code) => (code === 0 ? resolveRun({ stdout, stderr }) : rejectRun(new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`))));
    if (input) input(child.stdin);
  });
}

/** frames: [{ path, count }] - one JPEG shown for `count` consecutive frames. Writes a VP8/WebM at a
 * fixed frame rate, so video time is frame index / fps regardless of how long the capture took. */
export async function encodeWebm({ ffmpeg, frames, fps, out, signal }) {
  // -threads 1 and no alt-ref/lag keep libvpx single-pass and order-stable, so the same frames decode to
  // the same pixels on every encode. Container bytes are not promised identical; decoded hashes are.
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(fps), "-i", "pipe:0",
    "-c:v", "libvpx", "-pix_fmt", "yuv420p", "-b:v", "1500k", "-crf", "10", "-g", String(fps * 2),
    "-auto-alt-ref", "0", "-lag-in-frames", "0", "-threads", "1", "-an",
    "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-f", "webm", out,
  ];
  await run(ffmpeg, args, {
    signal,
    input: (stdin) => {
      stdin.on("error", () => { /* ffmpeg exited early; run() reports its stderr */ });
      (async () => {
        for (const { path, count } of frames) {
          const bytes = readFileSync(path);
          for (let i = 0; i < count; i++) if (!stdin.write(bytes)) await new Promise((r) => stdin.once("drain", r));
        }
        stdin.end();
      })().catch(() => stdin.destroy());
    },
  });
}

/** sha256 of every decoded frame (decoded to PNG, because there is no rawvideo muxer), plus a digest of
 * the list. Two captures of the same scenario must agree here; the container bytes may differ. */
export async function decodedFrameHashes({ ffmpeg, video, scratch, signal }) {
  const dir = join(scratch, `decode-${sha256(video).slice(0, 8)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", video, "-fps_mode", "passthrough", "-f", "image2", join(dir, "%06d.png")], { signal });
  const files = readdirSync(dir).filter((name) => name.endsWith(".png")).sort();
  const frames = files.map((name) => sha256(readFileSync(join(dir, name))));
  rmSync(dir, { recursive: true, force: true });
  return { frames, count: frames.length, digest: sha256(frames.join("\n")) };
}

/** What `ffmpeg -i` says about a file. NOT ffprobe: the banner is parsed, and the result is labelled so. */
export async function probeWithFfmpeg({ ffmpeg, video }) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-i", video], { encoding: "utf8" });
  const text = `${result.stderr ?? ""}`;
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const stream = /Video:\s*([^,\s]+)[^\n]*?,\s*([^,\s(]+)[^\n]*?,\s*(\d+)x(\d+)[^\n]*?,\s*(?:[\d.]+ kb\/s,\s*)?([\d.]+) fps/.exec(text);
  if (!duration || !stream) throw new Error(`ffmpeg could not read ${video}:\n${text.slice(-800)}`);
  return {
    tool: "ffmpeg -i banner (ffprobe is not installed)",
    durationSeconds: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    codec: stream[1],
    pixelFormat: stream[2],
    width: Number(stream[3]),
    height: Number(stream[4]),
    fps: Number(stream[5]),
  };
}

/** Compiles the Swift tool into scratch. Returns null when there is no Swift toolchain / not macOS. */
export async function buildMp4Tool({ scratch, signal }) {
  if (process.platform !== "darwin") return null;
  const swiftc = spawnSync("which", ["swiftc"], { encoding: "utf8" });
  if (swiftc.status !== 0) return null;
  const tool = join(scratch, "marketing-video-mp4");
  try {
    await run(swiftc.stdout.trim(), ["-O", "-module-cache-path", join(scratch, "swift-modules"), SWIFT_SOURCE, "-o", tool], { signal });
  } catch (error) {
    console.warn(`MP4 tool did not compile (WebM only): ${error.message.split("\n")[0]}`);
    return null;
  }
  return tool;
}

export async function encodeMp4({ tool, frames, fps, out, scratch, signal }) {
  const manifest = join(scratch, "mp4-manifest.tsv");
  writeFileSync(manifest, frames.map(({ path, count }) => `${path}\t${count}`).join("\n"));
  // AVAssetWriter leaves a sandbox temp sibling (`<name>.sb-*`) next to its output; encoding in scratch and
  // copying the finished file keeps the published directory free of it.
  const staged = join(scratch, "staged.mp4");
  await run(tool, ["encode", manifest, staged, String(fps)], { signal });
  // AVAssetWriter stamps wall-clock creation dates in movie/track headers. A stream-copy remux
  // removes those dates and enables fast start without re-encoding captured UI pixels.
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) throw new Error("MP4 metadata stripping requires an ffmpeg with MP4 demux/mux support");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", staged, "-map_metadata", "-1", "-map_metadata:s:v", "-1", "-c", "copy", "-movflags", "+faststart", out], { signal });
}

export async function probeMp4({ tool, video, signal }) {
  const { stdout } = await run(tool, ["probe", video], { signal });
  return JSON.parse(stdout);
}
