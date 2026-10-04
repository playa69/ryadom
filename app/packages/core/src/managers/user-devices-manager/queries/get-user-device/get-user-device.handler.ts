import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { userDevices } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toUserDeviceDTO } from '../../shared/user-device.dto'
import { GetUserDeviceQuery } from './get-user-device.query'
import { GetUserDeviceQueryErrorCode, type GetUserDeviceQueryResult } from './get-user-device.types'

@requestHandler(GetUserDeviceQuery)
export class GetUserDeviceQueryHandler implements RequestHandler<
  GetUserDeviceQuery,
  GetUserDeviceQueryResult
> {
  async handle(query: GetUserDeviceQuery): Promise<GetUserDeviceQueryResult> {
    const [row] = await getDb().select().from(userDevices).where(eq(userDevices.deviceId, query.deviceId))
    if (!row) return { success: false, error: GetUserDeviceQueryErrorCode.DEVICE_NOT_FOUND }
    return { success: true, device: toUserDeviceDTO(row) }
  }
}
