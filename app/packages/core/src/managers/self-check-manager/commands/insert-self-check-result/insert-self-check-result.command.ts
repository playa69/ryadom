import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { SelfCheckSubscale } from '@ryadom/db/schema'
import type { InsertSelfCheckResultCommandResult } from './insert-self-check-result.types'

export interface InsertSelfCheckResultCommandData {
  id: string
  userId: string
  testId: string
  testVersion: number
  score: number
  subscores: SelfCheckSubscale[] | null
  band: string
  takenAt: Date
}

export class InsertSelfCheckResultCommand extends RequestData<InsertSelfCheckResultCommandResult> {
  /** Survives build minification: InsertSelfCheckResultCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'InsertSelfCheckResultCommand'

  public readonly id: string
  public readonly userId: string
  public readonly testId: string
  public readonly testVersion: number
  @hasPII(true)
  public readonly score: number
  @hasPII(true)
  public readonly subscores: SelfCheckSubscale[] | null
  @hasPII(true)
  public readonly band: string
  public readonly takenAt: Date

  constructor(data: InsertSelfCheckResultCommandData) {
    super()
    this.id = data.id
    this.userId = data.userId
    this.testId = data.testId
    this.testVersion = data.testVersion
    this.score = data.score
    this.subscores = data.subscores
    this.band = data.band
    this.takenAt = data.takenAt
  }
}
