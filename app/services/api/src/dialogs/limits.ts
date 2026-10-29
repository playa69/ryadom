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
   * Binary audio frames: the client sends 25 a second (40 ms per frame; builds before that, 10 of
   * 100 ms). A bucket rather than a per-second count: a phone whose main thread stalls for a few
   * seconds delivers the backlog in one go, and that must not cut the person off, while a real flood
   * still runs the bucket dry. The api has to ship before clients with 40 ms frames: the old limit
   * of 20 a second cuts them off after a dozen seconds of speech.
   */
  audioFramesPerSecond: 50,
  audioFrameBurst: 150,
  /** Audio frame: 40 ms of PCM16 at 16 kHz is 1285 bytes with the header (100 ms: 3205); headroom for Opus later. */
  maxAudioFrameBytes: 16 * 1024,
} as const
