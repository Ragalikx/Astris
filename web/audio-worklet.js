// Plays the game's mixed sound (crates/horizon-client-render/src/audio.rs, mod web): a ring
// of interleaved stereo f32 samples in the shared wasm memory, with [read, write] frame
// counters before it. A Rust thread writes ahead; this reads and never blocks.
class HorizonOutput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = ({data}) => {
      this.indices = new Int32Array(data.buffer, data.indices, 2);
      this.samples = new Float32Array(data.buffer, data.samples, data.frames * 2);
      this.mask = data.frames - 1;
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    if (!this.indices || !out.length) return true;
    const left = out[0], right = out[1];
    const read = Atomics.load(this.indices, 0);
    const queued = (Atomics.load(this.indices, 1) - read) | 0;
    const n = Math.max(0, Math.min(left.length, queued));
    for (let i = 0; i < n; i++) {
      const at = ((read + i) & this.mask) * 2;
      left[i] = this.samples[at];
      if (right) right[i] = this.samples[at + 1];
    }
    // An underrun plays silence (the outputs start zeroed).
    Atomics.store(this.indices, 0, (read + n) | 0);
    return true;
  }
}
registerProcessor('horizon-output', HorizonOutput);
