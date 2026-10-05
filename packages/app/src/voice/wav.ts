export function pcm16Wav(samples: Float32Array): Uint8Array {
  if (!samples.length || samples.length > 960_000) throw new Error("Speech capture must be between 0 and 60 seconds");
  const bytes = new Uint8Array(44 + samples.length * 2); const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE"); tag(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => { if (!Number.isFinite(sample)) throw new Error("Invalid speech PCM"); const clamped = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true); });
  return bytes;
}
export async function speechPcm(audio: Blob, signal?: AbortSignal): Promise<Float32Array> {
  signal?.throwIfAborted(); if (audio.size > 8 * 1024 * 1024 || !audio.size) throw new Error("Speech capture is empty or too large");
  const decoder = new OfflineAudioContext(1, 1, 16000);
  const decoded = await decoder.decodeAudioData(await audio.arrayBuffer()); signal?.throwIfAborted();
  if (!decoded.duration || decoded.duration > 60) throw new Error("Speech capture exceeds 60 seconds");
  const context = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const source = context.createBufferSource(); source.buffer = decoded; source.connect(context.destination); source.start();
  const rendered = await context.startRendering(); signal?.throwIfAborted(); return rendered.getChannelData(0);
}
export function speechBase64(bytes: Uint8Array): string {
  let text = ""; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(text);
}
