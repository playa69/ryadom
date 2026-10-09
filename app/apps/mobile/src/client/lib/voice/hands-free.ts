export * from '@ryadom/client-core/voice/hands-free'

/**
 * Where this device keeps the "Разговор без рук" setting. The PWA shares its origin with the web
 * client, whose keys all start with `ryadom.web.`, so this one cannot collide with them.
 */
export const HANDS_FREE_KEY = 'ryadom.handsFree'
