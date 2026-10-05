import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { RequestAdminCodeResult } from './request-admin-code.types'

export interface RequestAdminCodeOperationData {
  email: string
}

export class RequestAdminCodeOperation extends RequestData<RequestAdminCodeResult> {
  /** Survives minification: RequestAdminCodeOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'RequestAdminCodeOperation'

  @hasPII()
  public readonly email: string

  constructor(data: RequestAdminCodeOperationData) {
    super()
    this.email = data.email
  }
}
