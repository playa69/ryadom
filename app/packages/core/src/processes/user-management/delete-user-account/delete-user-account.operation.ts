import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { DeleteUserAccountResult } from './delete-user-account.types'

export interface DeleteUserAccountOperationData {
  adminEmail: string
  userId: string
}

export class DeleteUserAccountOperation extends RequestData<DeleteUserAccountResult> {
  /** Survives minification: DeleteUserAccountOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteUserAccountOperation'

  @hasPII()
  public readonly adminEmail: string

  public readonly userId: string

  constructor(data: DeleteUserAccountOperationData) {
    super()
    this.adminEmail = data.adminEmail
    this.userId = data.userId
  }
}
