/**
 * The anonymous identity of a device: what `POST /api/auth/device` takes. The id names the device,
 * the key proves it is the one that made the account. Both are random and made here, once, on the
 * first anonymous sign-in, and then kept in the storage until the account is deleted.
 */
export interface DeviceCredentials {
  deviceId: string
  deviceKey: string
}

/** URL-safe base64 of random bytes: 16 bytes make 22 characters, 32 bytes make 43. */
function randomBase64Url(bytes: number): string {
  const crypto = globalThis.crypto
  // No fallback to Math.random: a key that can be guessed is worse than no anonymous sign-in.
  if (!crypto?.getRandomValues) throw new Error('Secure random numbers are not available on this device')
  const random = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...random))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

export function newDeviceCredentials(): DeviceCredentials {
  return { deviceId: randomBase64Url(16), deviceKey: randomBase64Url(32) }
}
