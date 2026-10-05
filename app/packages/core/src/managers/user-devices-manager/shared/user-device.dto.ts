import type { UserDeviceRow } from '@ryadom/db/schema'

/** A registered device. Core-internal type: the hash of the key is never handed out. */
export interface UserDeviceDTO {
  id: string
  userId: string
  deviceId: string
  keyHash: string
  createdAt: Date
}

export function toUserDeviceDTO(row: UserDeviceRow): UserDeviceDTO {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    keyHash: row.keyHash,
    createdAt: row.createdAt,
  }
}
