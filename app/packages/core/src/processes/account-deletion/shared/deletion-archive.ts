import assertNever from 'assert-never'
import {
  GetUserCredentialsQuery,
  GetUserCredentialsQueryErrorCode,
  userCredentialsManager,
} from '../../../managers/user-credentials-manager'
import type { UserDTO } from '../../../managers/users-manager'

/**
 * Snapshot of personal data taken before the cleanup: it stays in `users.properties.deletion`
 * in case of a legal request once the row has been anonymized. Keys are table names and row
 * fields are in snake_case, as in the database.
 *
 * Conversations are not here: the agent stores them and erases them itself, in full.
 */
export async function buildDeletionArchive(
  user: UserDTO,
  reason: string,
): Promise<Record<string, unknown>> {
  const credentials = await userCredentialsManager.execute(new GetUserCredentialsQuery({ userId: user.id }))
  if (!credentials.success) {
    switch (credentials.error) {
      case GetUserCredentialsQueryErrorCode.CREDENTIALS_NOT_FOUND:
        break // corrupted data: an account without a password
      default:
        assertNever(credentials.error)
    }
  }
  return {
    anonymized_at: new Date().toISOString(),
    reason,
    profile: {
      email: user.email,
      name: user.name,
      is_active: user.isActive,
      is_email_confirmed: user.isEmailConfirmed,
      created_at: user.createdAt.toISOString(),
    },
    user_credentials: credentials.success
      ? [
          {
            user_id: credentials.credentials.userId,
            password_hash: credentials.credentials.passwordHash,
            created_at: credentials.credentials.createdAt.toISOString(),
          },
        ]
      : [],
    agent_data_erased: true,
  }
}
