import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { userDevices } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { DeleteUserDevicesCommand } from './delete-user-devices.command'
import type { DeleteUserDevicesCommandResult } from './delete-user-devices.types'

/**
 * Forgets the user's devices (account deletion). The account is only anonymized, never removed, so
 * the rows do not go with it: left behind, they would sign the device in to a deleted account.
 * Idempotent.
 */
@requestHandler(DeleteUserDevicesCommand)
export class DeleteUserDevicesCommandHandler implements RequestHandler<
  DeleteUserDevicesCommand,
  DeleteUserDevicesCommandResult
> {
  async handle(command: DeleteUserDevicesCommand): Promise<DeleteUserDevicesCommandResult> {
    if (isUuid(command.userId))
      await getDb().delete(userDevices).where(eq(userDevices.userId, command.userId))
    return { success: true }
  }
}
