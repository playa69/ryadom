import { RequestData } from 'mediatr-ts'
import type { RenderPasswordChangedEmailRequestResult } from './render-password-changed-email.types'

export interface RenderPasswordChangedEmailRequestData {
  userName: string | null
  changedAt: Date
}

/** Password changed. */
export class RenderPasswordChangedEmailRequest extends RequestData<RenderPasswordChangedEmailRequestResult> {
  /** Survives build minification: RenderPasswordChangedEmailRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RenderPasswordChangedEmailRequest'

  public readonly userName: string | null
  public readonly changedAt: Date

  constructor(data: RenderPasswordChangedEmailRequestData) {
    super()
    this.userName = data.userName
    this.changedAt = data.changedAt
  }
}
