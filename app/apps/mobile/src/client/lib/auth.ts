import { client } from './platform-adapter'

/**
 * Session access for the app. Storage (secure storage + Preferences) is wired in
 * platform-adapter.ts; the rules (memory-only access token, restore, teardown) live in
 * @ryadom/client-core.
 */

export type { User } from '@ryadom/client-core/index'

export const restoreSession = client.restoreSession
export const startSession = client.startSession
export const endSession = client.endSession
export const signOut = client.signOut
export const saveUser = client.saveUser
