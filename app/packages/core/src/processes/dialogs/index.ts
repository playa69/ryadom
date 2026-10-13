// 1. Handler imports
import './start-dialog/start-dialog.handler'
import './list-dialogs/list-dialogs.handler'
import './get-dialog/get-dialog.handler'
import './end-dialog/end-dialog.handler'
import './recap-dialog/recap-dialog.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { StartDialogOperation } from './start-dialog/start-dialog.operation'
export type { StartDialogOperationData } from './start-dialog/start-dialog.operation'
export { ListDialogsOperation } from './list-dialogs/list-dialogs.operation'
export type { ListDialogsOperationData } from './list-dialogs/list-dialogs.operation'
export { GetDialogOperation } from './get-dialog/get-dialog.operation'
export type { GetDialogOperationData } from './get-dialog/get-dialog.operation'
export { EndDialogOperation } from './end-dialog/end-dialog.operation'
export type { EndDialogOperationData } from './end-dialog/end-dialog.operation'
export { RecapDialogOperation } from './recap-dialog/recap-dialog.operation'
export type { RecapDialogOperationData } from './recap-dialog/recap-dialog.operation'

// 3. Type re-exports
export type { StartDialogResult, StartedDialog } from './start-dialog/start-dialog.types'
export { StartDialogOperationErrorCode } from './start-dialog/start-dialog.types'
export type { ListDialogsResult } from './list-dialogs/list-dialogs.types'
export { ListDialogsOperationErrorCode } from './list-dialogs/list-dialogs.types'
export type { GetDialogResult } from './get-dialog/get-dialog.types'
export { GetDialogOperationErrorCode } from './get-dialog/get-dialog.types'
export type { EndDialogResult } from './end-dialog/end-dialog.types'
export { EndDialogOperationErrorCode } from './end-dialog/end-dialog.types'
export type { RecapDialogResult } from './recap-dialog/recap-dialog.types'
export { RecapDialogOperationErrorCode } from './recap-dialog/recap-dialog.types'
export type {
  DialogDTO,
  DialogListItemDTO,
  DialogMessageDTO,
  DialogSummaryDTO,
} from './shared/dialog.dto'

// 4. Union type
import type { StartDialogOperation } from './start-dialog/start-dialog.operation'
import type { ListDialogsOperation } from './list-dialogs/list-dialogs.operation'
import type { GetDialogOperation } from './get-dialog/get-dialog.operation'
import type { EndDialogOperation } from './end-dialog/end-dialog.operation'
import type { RecapDialogOperation } from './recap-dialog/recap-dialog.operation'

export type DialogsOperations =
  | StartDialogOperation
  | ListDialogsOperation
  | GetDialogOperation
  | EndDialogOperation
  | RecapDialogOperation

// 5. Facade
export class DialogsProcess implements IDialogsProcess {
  async execute<T extends DialogsOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: DialogsOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IDialogsProcess {
  execute<T extends DialogsOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const dialogsProcess: IDialogsProcess = new DialogsProcess()
