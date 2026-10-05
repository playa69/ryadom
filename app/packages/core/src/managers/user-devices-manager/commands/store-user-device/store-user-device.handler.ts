import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { userDevices } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { StoreUserDeviceCommand } from './store-user-device.command'
import { StoreUserDeviceCommandErrorCode, type StoreUserDeviceCommandResult } from './store-user-device.types'

/**
 * Registers a device. A device id is taken once: of two first sign-ins from the same device at the
 * same moment one stores it and the other learns it lost (DEVICE_ALREADY_EXISTS), without an
 * exception that would abort the process's transaction.
 */
@requestHandler(StoreUserDeviceCommand)
export class StoreUserDeviceCommandHandler implements RequestHandler<
  StoreUserDeviceCommand,
  StoreUserDeviceCommandResult
> {
  async handle(command: StoreUserDeviceCommand): Promise<StoreUserDeviceCommandResult> {
    const [row] = await getDb()
      .insert(userDevices)
      .values({
        id: command.recordId,
        userId: command.userId,
        deviceId: command.deviceId,
        keyHash: command.keyHash,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: userDevices.deviceId })
      .returning({ id: userDevices.id })
    if (!row) return { success: false, error: StoreUserDeviceCommandErrorCode.DEVICE_ALREADY_EXISTS }
    return { success: true }
  }
}
