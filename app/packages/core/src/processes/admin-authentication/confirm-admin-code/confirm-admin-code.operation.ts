import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { ConfirmAdminCodeResult } from './confirm-admin-code.types'

export interface ConfirmAdminCodeOperationData {
  email: string
  code: string
}

export class ConfirmAdminCodeOperation extends RequestData<ConfirmAdminCodeResult> {
  /** Survives minification: ConfirmAdminCodeOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ConfirmAdminCodeOperation'

  @hasPII()
  public readonly email: string

  @hasPII(true)
  public readonly code: string

  constructor(data: ConfirmAdminCodeOperationData) {
    super()
    this.email = data.email
    this.code = data.code
  }
}
