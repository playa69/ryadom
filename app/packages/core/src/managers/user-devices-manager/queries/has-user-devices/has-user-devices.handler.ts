import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { userDevices } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { HasUserDevicesQuery } from './has-user-devices.query'
import type { HasUserDevicesQueryResult } from './has-user-devices.types'

@requestHandler(HasUserDevicesQuery)
export class HasUserDevicesQueryHandler implements RequestHandler<
  HasUserDevicesQuery,
  HasUserDevicesQueryResult
> {
  async handle(query: HasUserDevicesQuery): Promise<HasUserDevicesQueryResult> {
    if (!isUuid(query.userId)) return { success: true, hasDevices: false }
    const [row] = await getDb()
      .select({ id: userDevices.id })
      .from(userDevices)
      .where(eq(userDevices.userId, query.userId))
      .limit(1)
    return { success: true, hasDevices: row !== undefined }
  }
}
