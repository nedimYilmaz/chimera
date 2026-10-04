// Local, same-origin module. PCM stays in memory and is never written to disk.
class RoomCapture extends AudioWorkletProcessor {
  constructor() { super(); this.frame = new Float32Array(1024); this.offset = 0; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      if (this.offset === 0) this.capturedAt = (currentFrame + i) / sampleRate;
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      this.frame[this.offset++] = sample / channels.length;
      if (this.offset === this.frame.length) {
        this.port.postMessage({ samples: this.frame, capturedAt: this.capturedAt }, [this.frame.buffer]);
        this.frame = new Float32Array(1024); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("chimera-room-capture", RoomCapture);
