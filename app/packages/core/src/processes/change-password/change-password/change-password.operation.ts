import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { ChangePasswordResult } from './change-password.types'

export interface ChangePasswordOperationData {
  userId: string
  currentPassword: string
  newPassword: string
  /** The session that made the change keeps working; every other one ends. Null ends all of them. */
  keepSessionId?: string | null
}

export class ChangePasswordOperation extends RequestData<ChangePasswordResult> {
  /** Survives minification: ChangePasswordOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ChangePasswordOperation'

  public readonly userId: string

  @hasPII(true)
  public readonly currentPassword: string

  @hasPII(true)
  public readonly newPassword: string

  public readonly keepSessionId: string | null

  constructor(data: ChangePasswordOperationData) {
    super()
    this.userId = data.userId
    this.currentPassword = data.currentPassword
    this.newPassword = data.newPassword
    this.keepSessionId = data.keepSessionId ?? null
  }
}
