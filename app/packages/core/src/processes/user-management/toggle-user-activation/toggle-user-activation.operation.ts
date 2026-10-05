import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { ToggleUserActivationResult } from './toggle-user-activation.types'

export interface ToggleUserActivationOperationData {
  adminEmail: string
  userId: string
}

export class ToggleUserActivationOperation extends RequestData<ToggleUserActivationResult> {
  /** Survives minification: ToggleUserActivationOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ToggleUserActivationOperation'

  @hasPII()
  public readonly adminEmail: string

  public readonly userId: string

  constructor(data: ToggleUserActivationOperationData) {
    super()
    this.adminEmail = data.adminEmail
    this.userId = data.userId
  }
}
