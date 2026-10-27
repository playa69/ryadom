import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { UpdateMemoryFactResult } from './update-memory-fact.types'

export interface UpdateMemoryFactOperationData {
  userId: string
  /** The id of a note. */
  factId: string
  /** The correction in the person's own words. */
  text: string
}

export class UpdateMemoryFactOperation extends RequestData<UpdateMemoryFactResult> {
  /** Survives minification: UpdateMemoryFactOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'UpdateMemoryFactOperation'

  public readonly userId: string
  public readonly factId: string

  @hasPII(true)
  public readonly text: string

  constructor(data: UpdateMemoryFactOperationData) {
    super()
    this.userId = data.userId
    this.factId = data.factId
    this.text = data.text
  }
}
