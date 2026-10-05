import { USER_CONSENT_KINDS } from '@ryadom/db/schema'
import { ListUserConsentsQuery, userConsentsManager } from '../../../managers/user-consents-manager'

/**
 * A conversation with the agent is closed until the person has agreed to everything on the first
 * screen. The app asks before it starts one, so this is the server not taking the app's word for it.
 */
export async function hasAllConsents(userId: string): Promise<boolean> {
  const { consents } = await userConsentsManager.execute(new ListUserConsentsQuery({ userId }))
  const kinds = new Set(consents.map((consent) => consent.kind))
  return USER_CONSENT_KINDS.every((kind) => kinds.has(kind))
}
