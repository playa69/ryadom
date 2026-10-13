/**
 * Stands in for `@eshaz/web-worker`, which `opus-decoder` (the WASM Opus decoder of the agent's voice,
 * client-core/voice/opus.ts) depends on for its web-worker flavour. The package's Node build holds an
 * import Turbopack cannot bundle, and the server render of client components would pull it in; in the
 * browser the package is nothing but the global `Worker`, which is all this gives every build. The
 * client never uses that flavour, and on the server the decoder is never loaded at all.
 */
const WorkerShim: typeof Worker | undefined = globalThis.Worker

export default WorkerShim
