import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { SaveSelfCheckResultResult } from './save-self-check-result.types'

export interface SaveSelfCheckResultOperationData {
  userId: string
  testId: string
  testVersion: number
  answers: number[]
  takenAt?: Date
  now?: Date
  preview: boolean
}

export class SaveSelfCheckResultOperation extends RequestData<SaveSelfCheckResultResult> {
  /** Survives build minification: SaveSelfCheckResultOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'SaveSelfCheckResultOperation'

  public readonly userId: string
  public readonly testId: string
  public readonly testVersion: number
  @hasPII(true)
  public readonly answers: number[]
  public readonly takenAt?: Date
  public readonly now?: Date
  public readonly preview: boolean

  constructor(data: SaveSelfCheckResultOperationData) {
    super()
    this.userId = data.userId
    this.testId = data.testId
    this.testVersion = data.testVersion
    this.answers = data.answers
    this.takenAt = data.takenAt
    this.now = data.now
    this.preview = data.preview
  }
}
