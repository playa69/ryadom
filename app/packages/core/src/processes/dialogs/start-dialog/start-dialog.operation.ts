import { RequestData } from 'mediatr-ts'
import type { AgentDialogMemoryMode } from '../../../integrations/agent-api'
import type { StartDialogResult } from './start-dialog.types'

export interface StartDialogOperationData {
  userId: string
  /**
   * The person chose to end the open dialog and begin a new one. Without it a start only returns the
   * open dialog (if there is one) and changes nothing.
   */
  startNew?: boolean
  /**
   * `off`: the person asked for a conversation "without memory". Only a new dialog takes it; a returned
   * open one keeps the mode it was started with.
   */
  memory?: AgentDialogMemoryMode
}

export class StartDialogOperation extends RequestData<StartDialogResult> {
  /** Survives minification: StartDialogOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'StartDialogOperation'

  public readonly userId: string
  public readonly startNew: boolean
  public readonly memory: AgentDialogMemoryMode | undefined

  constructor(data: StartDialogOperationData) {
    super()
    this.userId = data.userId
    this.startNew = data.startNew === true
    this.memory = data.memory
  }
}
