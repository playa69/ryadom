import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { RenderEmailConfirmationEmailRequestResult } from './render-email-confirmation-email.types'

export interface RenderEmailConfirmationEmailRequestData {
  userName: string | null
  code: string
  expiresInMinutes: number
}

/** A repeat email confirmation message carrying the code. */
export class RenderEmailConfirmationEmailRequest extends RequestData<RenderEmailConfirmationEmailRequestResult> {
  /** Survives build minification: RenderEmailConfirmationEmailRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RenderEmailConfirmationEmailRequest'

  public readonly userName: string | null

  @hasPII(true)
  public readonly code: string

  public readonly expiresInMinutes: number

  constructor(data: RenderEmailConfirmationEmailRequestData) {
    super()
    this.userName = data.userName
    this.code = data.code
    this.expiresInMinutes = data.expiresInMinutes
  }
}
