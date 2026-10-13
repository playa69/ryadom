/**
 * The WebAssembly build of `@evan/opus` (libopus), imported by its own path. The package's typings
 * cover only its entry point, which tries a native binary first; those binaries are built for glibc
 * and the image is Alpine (musl), so the gateway takes the WASM build directly. It is CommonJS:
 * `module.exports = { Encoder, Decoder }`.
 */
declare module '@evan/opus/wasm/index.js' {
  interface OpusOptions {
    channels?: 1 | 2
    sample_rate?: 8000 | 12000 | 16000 | 24000 | 48000
  }

  class Encoder {
    constructor(options: OpusOptions & { application?: 'voip' | 'audio' | 'restricted_lowdelay' })
    /** Without a value reads the setting, with one sets it (`OPUS_SET_*` request numbers). */
    ctl(request: number, value?: number): number
    /** One packet from exactly one frame of samples (PCM16, little-endian bytes); a copy. */
    encode(pcm: ArrayBufferView): Uint8Array
    /** Frees the encoder's memory inside the module. */
    drop(): void
  }

  class Decoder {
    constructor(options: OpusOptions)
    ctl(request: number, value?: number): number
    /** One packet to PCM16 samples (little-endian bytes); a copy. */
    decode(packet: ArrayBufferView): Uint8Array
    drop(): void
  }

  const opus: { Encoder: typeof Encoder; Decoder: typeof Decoder }
  export default opus
}
