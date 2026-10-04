/**
 * Loudness of one AnalyserNode time-domain frame, 0..1. The bytes are centred on 128 (silence).
 *
 * Plain speech sits around 0.02-0.2 RMS, so the value is stretched: the voice orb moves visibly for
 * a quiet voice and saturates on a loud one instead of barely twitching.
 */
export function levelOf(samples: Uint8Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const byte of samples) {
    const centred = (byte - 128) / 128
    sum += centred * centred
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 4)
}
