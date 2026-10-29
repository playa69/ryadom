// 1. Handler imports
import './start-dialog/start-dialog.handler'
import './list-dialogs/list-dialogs.handler'
import './get-dialog/get-dialog.handler'
import './end-dialog/end-dialog.handler'
import './delete-dialog/delete-dialog.handler'
import './confirm-dialog-deleted/confirm-dialog-deleted.handler'
import './list-recaps/list-recaps.handler'
import './draft-recap/draft-recap.handler'
import './put-recap/put-recap.handler'
import './get-dialog-settings/get-dialog-settings.handler'
import './put-dialog-settings/put-dialog-settings.handler'

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
export { DeleteDialogOperation } from './delete-dialog/delete-dialog.operation'
export type { DeleteDialogOperationData } from './delete-dialog/delete-dialog.operation'
export { ConfirmDialogDeletedOperation } from './confirm-dialog-deleted/confirm-dialog-deleted.operation'
export type { ConfirmDialogDeletedOperationData } from './confirm-dialog-deleted/confirm-dialog-deleted.operation'
export { ListRecapsOperation } from './list-recaps/list-recaps.operation'
export type { ListRecapsOperationData } from './list-recaps/list-recaps.operation'
export { DraftRecapOperation } from './draft-recap/draft-recap.operation'
export type { DraftRecapOperationData } from './draft-recap/draft-recap.operation'
export { PutRecapOperation } from './put-recap/put-recap.operation'
export type { PutRecapOperationData } from './put-recap/put-recap.operation'
export { GetDialogSettingsOperation } from './get-dialog-settings/get-dialog-settings.operation'
export type { GetDialogSettingsOperationData } from './get-dialog-settings/get-dialog-settings.operation'
export { PutDialogSettingsOperation } from './put-dialog-settings/put-dialog-settings.operation'
export type { PutDialogSettingsOperationData } from './put-dialog-settings/put-dialog-settings.operation'

// 3. Type re-exports
export type { StartDialogResult, StartedDialog } from './start-dialog/start-dialog.types'
export { StartDialogOperationErrorCode } from './start-dialog/start-dialog.types'
export type { ListDialogsResult } from './list-dialogs/list-dialogs.types'
export { ListDialogsOperationErrorCode } from './list-dialogs/list-dialogs.types'
export type { GetDialogResult } from './get-dialog/get-dialog.types'
export { GetDialogOperationErrorCode } from './get-dialog/get-dialog.types'
export type { EndDialogResult } from './end-dialog/end-dialog.types'
export { EndDialogOperationErrorCode } from './end-dialog/end-dialog.types'
export type { DeleteDialogResult } from './delete-dialog/delete-dialog.types'
export { DeleteDialogOperationErrorCode } from './delete-dialog/delete-dialog.types'
export type { ConfirmDialogDeletedResult } from './confirm-dialog-deleted/confirm-dialog-deleted.types'
export type { ListRecapsResult } from './list-recaps/list-recaps.types'
export { ListRecapsOperationErrorCode } from './list-recaps/list-recaps.types'
export type { DraftRecapResult } from './draft-recap/draft-recap.types'
export { DraftRecapOperationErrorCode } from './draft-recap/draft-recap.types'
export type { PutRecapResult } from './put-recap/put-recap.types'
export { PutRecapOperationErrorCode } from './put-recap/put-recap.types'
export type { GetDialogSettingsResult } from './get-dialog-settings/get-dialog-settings.types'
export { GetDialogSettingsOperationErrorCode } from './get-dialog-settings/get-dialog-settings.types'
export type { PutDialogSettingsResult } from './put-dialog-settings/put-dialog-settings.types'
export { PutDialogSettingsOperationErrorCode } from './put-dialog-settings/put-dialog-settings.types'
export type {
  DialogDTO,
  DialogListItemDTO,
  DialogMessageDTO,
  DialogRecapItemDTO,
  DialogRecapSource,
  DialogRecapStatus,
  DialogSummaryDTO,
} from './shared/dialog.dto'

// 4. Union type
import type { StartDialogOperation } from './start-dialog/start-dialog.operation'
import type { ListDialogsOperation } from './list-dialogs/list-dialogs.operation'
import type { GetDialogOperation } from './get-dialog/get-dialog.operation'
import type { EndDialogOperation } from './end-dialog/end-dialog.operation'
import type { DeleteDialogOperation } from './delete-dialog/delete-dialog.operation'
import type { ConfirmDialogDeletedOperation } from './confirm-dialog-deleted/confirm-dialog-deleted.operation'
import type { ListRecapsOperation } from './list-recaps/list-recaps.operation'
import type { DraftRecapOperation } from './draft-recap/draft-recap.operation'
import type { PutRecapOperation } from './put-recap/put-recap.operation'
import type { GetDialogSettingsOperation } from './get-dialog-settings/get-dialog-settings.operation'
import type { PutDialogSettingsOperation } from './put-dialog-settings/put-dialog-settings.operation'

export type DialogsOperations =
  | StartDialogOperation
  | ListDialogsOperation
  | GetDialogOperation
  | EndDialogOperation
  | DeleteDialogOperation
  | ConfirmDialogDeletedOperation
  | ListRecapsOperation
  | DraftRecapOperation
  | PutRecapOperation
  | GetDialogSettingsOperation
  | PutDialogSettingsOperation

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
