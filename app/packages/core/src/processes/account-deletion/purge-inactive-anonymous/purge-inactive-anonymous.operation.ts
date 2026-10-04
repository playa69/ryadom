import { RequestData } from 'mediatr-ts'
import type { PurgeInactiveAnonymousResult } from './purge-inactive-anonymous.types'

export interface PurgeInactiveAnonymousOperationData {
  /** Accounts last seen before this moment are erased. */
  inactiveSince: Date
  /** At most this many in one run; the rest wait for the next. */
  limit: number
}

export class PurgeInactiveAnonymousOperation extends RequestData<PurgeInactiveAnonymousResult> {
  /** Survives minification: PurgeInactiveAnonymousOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'PurgeInactiveAnonymousOperation'

  public readonly inactiveSince: Date
  public readonly limit: number

  constructor(data: PurgeInactiveAnonymousOperationData) {
    super()
    this.inactiveSince = data.inactiveSince
    this.limit = data.limit
  }
}
