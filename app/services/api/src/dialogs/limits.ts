/** Limits of a single dialog connection. */
export const DIALOG_LIMITS = {
  /** The first `hello` frame must arrive within this time, otherwise the connection is closed. */
  helloTimeoutMs: 5_000,
  /** One message per second, with a short burst allowed. */
  messagesPerSecond: 1,
  messageBurst: 5,
  /** Heartbeat: ping every 30 seconds, two missed pongs close the connection. */
  heartbeatMs: 30_000,
  /**
   * Binary audio frames: the client sends 10 a second (100 ms per frame). A bucket rather than a
   * per-second count: a phone whose main thread stalls for a few seconds delivers the backlog in one
   * go, and that must not cut the person off, while a real flood still runs the bucket dry.
   */
  audioFramesPerSecond: 20,
  audioFrameBurst: 60,
  /** Audio frame: 100 ms of PCM16 at 16 kHz is 3205 bytes with the header; headroom for Opus later. */
  maxAudioFrameBytes: 16 * 1024,
} as const
