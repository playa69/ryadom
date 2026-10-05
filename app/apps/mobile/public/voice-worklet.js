/**
 * Microphone capture AudioWorklet.
 *
 * It runs on the audio thread, so it ships as a standalone file in public/ instead of going
 * through the bundle: bundler modules do not reach that thread. Its only job is to turn float32
 * into PCM16 at the target rate and emit 100 ms frames.
 *
 * Resampling is linear: good enough for speech and the recognition that follows, whereas a heavy
 * filter on the audio thread would cost dropouts.
 */
const TARGET_SAMPLE_RATE = 16000
const FRAME_MS = 100

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / TARGET_SAMPLE_RATE
    this.frameSamples = (TARGET_SAMPLE_RATE * FRAME_MS) / 1000
    this.buffer = new Int16Array(this.frameSamples)
    this.filled = 0
    this.position = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    // Walk the output grid: the position in source samples advances by ratio per output sample.
    while (this.position < channel.length) {
      const index = Math.floor(this.position)
      const sample = channel[index] ?? 0
      const clamped = Math.max(-1, Math.min(1, sample))
      this.buffer[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      this.position += this.ratio

      if (this.filled === this.frameSamples) {
        this.port.postMessage(this.buffer.slice(0), [])
        this.filled = 0
      }
    }
    this.position -= channel.length
    return true
  }
}

registerProcessor('ryadom-capture', CaptureProcessor)
