import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { DeleteEmailCodesCommandResult } from './delete-email-codes.types'

export interface DeleteEmailCodesCommandData {
  email: string
}

/** All codes for an address, of any purpose: needed when an account is deleted. */
export class DeleteEmailCodesCommand extends RequestData<DeleteEmailCodesCommandResult> {
  /** Survives minification: DeleteEmailCodesCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteEmailCodesCommand'

  @hasPII()
  public readonly email: string

  constructor(data: DeleteEmailCodesCommandData) {
    super()
    this.email = data.email
  }
}
