import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { RenderAdminCodeEmailRequestResult } from './render-admin-code-email.types'

export interface RenderAdminCodeEmailRequestData {
  code: string
  expiresInMinutes: number
}

export class RenderAdminCodeEmailRequest extends RequestData<RenderAdminCodeEmailRequestResult> {
  /** Survives build minification: RenderAdminCodeEmailRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RenderAdminCodeEmailRequest'

  @hasPII(true)
  public readonly code: string

  public readonly expiresInMinutes: number

  constructor(data: RenderAdminCodeEmailRequestData) {
    super()
    this.code = data.code
    this.expiresInMinutes = data.expiresInMinutes
  }
}
