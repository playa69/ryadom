import { RequestData } from 'mediatr-ts'
import type { FindDialogShareByTokenQueryResult } from './find-dialog-share-by-token.types'

export interface FindDialogShareByTokenQueryData {
  tokenHash: string
  now: Date
}

export class FindDialogShareByTokenQuery extends RequestData<FindDialogShareByTokenQueryResult> {
  /** Survives minification: FindDialogShareByTokenQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'FindDialogShareByTokenQuery'

  public readonly tokenHash: string
  public readonly now: Date

  constructor(data: FindDialogShareByTokenQueryData) {
    super()
    this.tokenHash = data.tokenHash
    this.now = data.now
  }
}
