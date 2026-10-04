// VOICE S5 (§4 "App audio/UI layer"): the AudioContext playback seam for a future engine whose
// synthesize() returns raw PCM instead of self-playing (e.g. a cloud TTS adapter, S8/S9). The
// shipped local default (speechSynthesisEngine) plays itself, so nothing calls this yet — it
// exists now so S7/S8/S9 don't need a new module for it.
export function playPcm16(samples: Int16Array, sampleRate: number): Promise<void> {
  if (typeof AudioContext === "undefined") return Promise.reject(new Error("AudioContext is unavailable in this window"));
  const ctx = new AudioContext();
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) channel[i] = (samples[i] ?? 0) / 32768;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  return new Promise((resolve) => {
    source.onended = () => { resolve(); void ctx.close(); };
    source.start();
  });
}
