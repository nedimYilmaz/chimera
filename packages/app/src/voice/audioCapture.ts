declare global { interface Window { __CHIMERA_VOICE_REAL_CAPTURE__?: boolean } }
// VOICE S5 (§4 "App audio/UI layer"): push-to-talk mic capture — getUserMedia/MediaRecorder,
// with a no-op capture under the window.__CHIMERA_MOCK__ test seam (same gate the rpc bridge
// uses) so headless tests never touch a real mic and the mock STT engine's scripted transcript
// is all that matters end-to-end.
export type AudioCapture = {
  start(): Promise<void>;
  cancel?(): void;
  /** Stop recording and return the captured audio (empty under the mock seam — the mock STT
   * engine ignores its input and returns a scripted transcript regardless). */
  stop(): Promise<Blob>;
};

function mockSeamActive(): boolean {
  return import.meta.env.DEV && typeof window !== "undefined" && !!window.__CHIMERA_MOCK__;
}

function createMockAudioCapture(): AudioCapture {
  return {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(new Blob()),
  };
}

function createMediaRecorderCapture(onFailure?: (error: Error) => void): AudioCapture {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let recordingError: Error | null = null;
  let cancelled = false;
  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  let bytes = 0;
  return {
    cancel(): void {
      cancelled = true; clearTimeout(limitTimer); stream?.getTracks().forEach(t => t.stop());
      try { if (recorder && recorder.state !== "inactive") recorder.stop(); } catch { /* tracks already released */ }
    },
    async start(): Promise<void> {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable on this platform");
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); stream = null; throw new Error("Microphone capture cancelled"); }
      chunks = [];
      recordingError = null;
      try {
        recorder = new MediaRecorder(stream);
        const sessionChunks = chunks;
        const sessionStream = stream;
        const sessionRecorder = recorder;
        const fail = (message: string) => {
          recordingError = new Error(message); sessionStream.getTracks().forEach(t => t.stop());
          try { if (sessionRecorder.state !== "inactive") sessionRecorder.stop(); } catch { /* released */ }
          onFailure?.(recordingError);
        };
        recorder.ondataavailable = (ev) => { bytes += ev.data.size; if (bytes > 8 * 1024 * 1024) fail("Speech capture is too large"); else if (ev.data.size > 0) sessionChunks.push(ev.data); };
        limitTimer = setTimeout(() => fail("Speech capture reached the 60 second limit; hold again for a shorter clip"), 60000);
        recorder.onerror = () => fail("microphone recorder failed");
        sessionStream.getTracks().forEach(track => { track.onended = () => fail("microphone device disconnected"); });
        recorder.start(250);
      } catch (err) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
        recorder = null;
        throw err;
      }
    },
    stop(): Promise<Blob> {
      clearTimeout(limitTimer);
      return new Promise((resolve, reject) => {
        const activeRecorder = recorder;
        const activeStream = stream;
        const capturedChunks = chunks;
        recorder = null;
        stream = null;
        const release = () => activeStream?.getTracks().forEach((t) => t.stop());
        if (!activeRecorder) { release(); reject(new Error("audio capture was never started")); return; }
        let finished = false;
        const finish = (error?: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          release();
          activeRecorder.onstop = null;
          activeRecorder.onerror = null;
          activeRecorder.ondataavailable = null;
          if (error) reject(error);
          else resolve(new Blob(capturedChunks, { type: activeRecorder.mimeType || "audio/webm" }));
        };
        // A broken recorder may never emit stop/error. Do not strand the UI or
        // retain the microphone while waiting for its final blob indefinitely.
        const timer = setTimeout(() => finish(new Error("microphone recorder did not stop")), 5000);
        activeRecorder.onerror = () => finish(new Error("microphone recorder failed"));
        activeRecorder.onstop = () => finish(recordingError);
        try {
          if (activeRecorder.state === "inactive") {
            finish(recordingError);
          } else { activeRecorder.stop(); release(); }
        } catch (err) { finish(err); }
      });
    },
  };
}

export function createAudioCapture(onFailure?: (error: Error) => void): AudioCapture {
  return mockSeamActive() && !window.__CHIMERA_VOICE_REAL_CAPTURE__ ? createMockAudioCapture() : createMediaRecorderCapture(onFailure);
}
