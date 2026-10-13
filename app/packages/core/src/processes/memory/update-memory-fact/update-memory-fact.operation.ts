import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { MemoryFactSlotsDTO } from '../shared/memory.dto'
import type { UpdateMemoryFactResult } from './update-memory-fact.types'

export interface UpdateMemoryFactOperationData {
  userId: string
  factId: string
  /** A correction in the person's own words. */
  text?: string
  slots?: MemoryFactSlotsDTO
  /** `active`: "Remember" a proposed fact, or unpin; `pinned`: pin. */
  status?: 'active' | 'pinned'
  /** "Right". */
  confirm?: true
}

export class UpdateMemoryFactOperation extends RequestData<UpdateMemoryFactResult> {
  /** Survives minification: UpdateMemoryFactOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'UpdateMemoryFactOperation'

  public readonly userId: string
  public readonly factId: string

  @hasPII(true)
  public readonly text: string | undefined

  @hasPII(true)
  public readonly slots: MemoryFactSlotsDTO | undefined

  public readonly status: 'active' | 'pinned' | undefined
  public readonly confirm: true | undefined

  constructor(data: UpdateMemoryFactOperationData) {
    super()
    this.userId = data.userId
    this.factId = data.factId
    this.text = data.text
    this.slots = data.slots
    this.status = data.status
    this.confirm = data.confirm
  }
}
