import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { LinkEmailResult } from './link-email.types'

export interface LinkEmailOperationData {
  userId: string
  email: string
  password: string
}

export class LinkEmailOperation extends RequestData<LinkEmailResult> {
  /** Survives minification: LinkEmailOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'LinkEmailOperation'

  public readonly userId: string

  @hasPII()
  public readonly email: string

  @hasPII(true)
  public readonly password: string

  constructor(data: LinkEmailOperationData) {
    super()
    this.userId = data.userId
    this.email = data.email
    this.password = data.password
  }
}
