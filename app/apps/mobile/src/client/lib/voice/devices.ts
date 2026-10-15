export * from '@ryadom/client-core/voice/devices'

/**
 * Where this device keeps the microphone and speaker chosen for conversations. The PWA shares its origin
 * with the web client, whose keys all start with `ryadom.web.`, so this one cannot collide with them.
 */
export const AUDIO_DEVICES_KEY = 'ryadom.audioDevices'
