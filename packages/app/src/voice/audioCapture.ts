// VOICE S5 (§4 "App audio/UI layer"): push-to-talk mic capture — getUserMedia/MediaRecorder,
// with a no-op capture under the window.__CHIMERA_MOCK__ test seam (same gate the rpc bridge
// uses) so headless tests never touch a real mic and the mock STT engine's scripted transcript
// is all that matters end-to-end.
export type AudioCapture = {
  start(): Promise<void>;
  /** Stop recording and return the captured audio (empty under the mock seam — the mock STT
   * engine ignores its input and returns a scripted transcript regardless). */
  stop(): Promise<Blob>;
};

function mockSeamActive(): boolean {
  return typeof window !== "undefined" && !!window.__CHIMERA_MOCK__;
}

function createMockAudioCapture(): AudioCapture {
  return {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(new Blob()),
  };
}

function createMediaRecorderCapture(): AudioCapture {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let recordingError: Error | null = null;
  return {
    async start(): Promise<void> {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      recordingError = null;
      try {
        recorder = new MediaRecorder(stream);
        const sessionChunks = chunks;
        const sessionStream = stream;
        const sessionRecorder = recorder;
        recorder.ondataavailable = (ev) => { if (ev.data.size > 0) sessionChunks.push(ev.data); };
        recorder.onerror = () => {
          recordingError = new Error("microphone recorder failed");
          sessionStream.getTracks().forEach((track) => track.stop());
          try { if (sessionRecorder.state !== "inactive") sessionRecorder.stop(); } catch { /* tracks are already released */ }
        };
        recorder.start();
      } catch (err) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
        recorder = null;
        throw err;
      }
    },
    stop(): Promise<Blob> {
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

export function createAudioCapture(): AudioCapture {
  return mockSeamActive() ? createMockAudioCapture() : createMediaRecorderCapture();
}
