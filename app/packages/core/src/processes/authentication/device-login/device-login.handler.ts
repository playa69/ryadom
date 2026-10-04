import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, inTransaction, validateInput } from '../../../shared'
import {
  CreateUserCommand,
  CreateUserCommandErrorCode,
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  usersManager,
  type UserDTO,
} from '../../../managers/users-manager'
import {
  GetUserDeviceQuery,
  GetUserDeviceQueryErrorCode,
  StoreUserDeviceCommand,
  StoreUserDeviceCommandErrorCode,
  userDevicesManager,
  type UserDeviceDTO,
} from '../../../managers/user-devices-manager'
import { HashTokenRequest, tokenService, VerifyTokenRequest } from '../../../services/token-service'
import { DeviceLoginOperation } from './device-login.operation'
import { DeviceLoginOperationErrorCode, type DeviceLoginResult } from './device-login.types'
import { deviceLoginSchema } from './device-login.validator'

/** A device id that another request registered while this one was making the account. */
class DeviceIdTaken extends Error {}

/**
 * Sign-in without an email. A device that has never been seen gets an account of its own, with no
 * address and no password; a device that has been seen proves itself with its key and gets the same
 * account back. This is the anonymous way in: an address can be linked later (`link-email`), which
 * turns it into an ordinary account that also signs in by email.
 *
 * Whether the device id is known is visible from outside (a new one makes an account), but nothing
 * else is: a wrong key for a known id is DEVICE_KEY_INVALID and says nothing about the account.
 */
@requestHandler(DeviceLoginOperation)
export class DeviceLoginOperationHandler implements RequestHandler<DeviceLoginOperation, DeviceLoginResult> {
  async handle(operation: DeviceLoginOperation): Promise<DeviceLoginResult> {
    const logger = createLogger('authentication')
    const input = validateInput(deviceLoginSchema, {
      deviceId: operation.deviceId,
      deviceKey: operation.deviceKey,
    })

    // Two goes: a first sign-in that loses the race for a device id finds the winner on the second.
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = await userDevicesManager.execute(new GetUserDeviceQuery({ deviceId: input.deviceId }))
      if (found.success) return this.signIn(found.device, input.deviceKey)
      switch (found.error) {
        case GetUserDeviceQueryErrorCode.DEVICE_NOT_FOUND:
          break
        default:
          assertNever(found.error)
      }

      const user = await this.createAccount(input.deviceId, input.deviceKey)
      if (user) {
        logger.info('Anonymous account created', { userId: user.id })
        return { success: true, user, isNewAccount: true }
      }
    }
    throw new Error('A device id kept appearing and disappearing')
  }

  private async signIn(device: UserDeviceDTO, deviceKey: string): Promise<DeviceLoginResult> {
    const logger = createLogger('authentication')
    const { isValid } = await tokenService.execute(
      new VerifyTokenRequest({ token: deviceKey, tokenHash: device.keyHash }),
    )
    if (!isValid) {
      logger.info('Device sign-in refused: wrong key', { userId: device.userId })
      return { success: false, error: DeviceLoginOperationErrorCode.DEVICE_KEY_INVALID }
    }

    const userResult = await usersManager.execute(new GetUserByIdQuery({ userId: device.userId }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          throw new Error('A registered device has no user')
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    // Deleting an account forgets its devices, so this is only a guard against stale data.
    if (user.isDeleted) return { success: false, error: DeviceLoginOperationErrorCode.DEVICE_KEY_INVALID }
    if (!user.isActive) {
      logger.info('Device sign-in refused: user inactive', { userId: user.id })
      return { success: false, error: DeviceLoginOperationErrorCode.USER_INACTIVE }
    }
    logger.info('Device signed in', { userId: user.id })
    return { success: true, user, isNewAccount: false }
  }

  /** The account and its device in one transaction; null when another request registered the id first. */
  private async createAccount(deviceId: string, deviceKey: string): Promise<UserDTO | null> {
    const { tokenHash: keyHash } = await tokenService.execute(new HashTokenRequest({ token: deviceKey }))
    const userId = randomUUID()
    try {
      return await inTransaction(async (): Promise<UserDTO> => {
        const created = await usersManager.execute(
          new CreateUserCommand({ userId, email: null, name: null, isEmailConfirmed: false }),
        )
        if (!created.success) {
          switch (created.error) {
            case CreateUserCommandErrorCode.USER_ALREADY_EXISTS:
              throw new Error('A random user id collided with an existing one')
            default:
              assertNever(created.error)
          }
        }
        const stored = await userDevicesManager.execute(
          new StoreUserDeviceCommand({ recordId: randomUUID(), userId, deviceId, keyHash }),
        )
        if (!stored.success) {
          switch (stored.error) {
            // Throwing rolls the new user back; the id is the winner's.
            case StoreUserDeviceCommandErrorCode.DEVICE_ALREADY_EXISTS:
              throw new DeviceIdTaken()
            default:
              assertNever(stored.error)
          }
        }
        const userResult = await usersManager.execute(new GetUserByIdQuery({ userId }))
        if (!userResult.success) {
          switch (userResult.error) {
            case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
              throw new Error('Just created user not found')
            default:
              assertNever(userResult.error)
          }
        }
        return userResult.user
      })
    } catch (error) {
      if (error instanceof DeviceIdTaken) return null
      throw error
    }
  }
}
