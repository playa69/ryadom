import { RequestData } from 'mediatr-ts'
import type { DeleteSelfCheckConsentCommandResult } from './delete-self-check-consent.types'

export interface DeleteSelfCheckConsentCommandData {
  userId: string
}

export class DeleteSelfCheckConsentCommand extends RequestData<DeleteSelfCheckConsentCommandResult> {
  /** Survives build minification: DeleteSelfCheckConsentCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteSelfCheckConsentCommand'

  public readonly userId: string

  constructor(data: DeleteSelfCheckConsentCommandData) {
    super()
    this.userId = data.userId
  }
}
