// 1. Handler imports
import './create-dialog-share/create-dialog-share.handler'
import './get-dialog-share/get-dialog-share.handler'
import './revoke-dialog-share/revoke-dialog-share.handler'
import './view-shared-dialog/view-shared-dialog.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { CreateDialogShareOperation } from './create-dialog-share/create-dialog-share.operation'
export type { CreateDialogShareOperationData } from './create-dialog-share/create-dialog-share.operation'
export { GetDialogShareOperation } from './get-dialog-share/get-dialog-share.operation'
export type { GetDialogShareOperationData } from './get-dialog-share/get-dialog-share.operation'
export { RevokeDialogShareOperation } from './revoke-dialog-share/revoke-dialog-share.operation'
export type { RevokeDialogShareOperationData } from './revoke-dialog-share/revoke-dialog-share.operation'
export { ViewSharedDialogOperation } from './view-shared-dialog/view-shared-dialog.operation'
export type { ViewSharedDialogOperationData } from './view-shared-dialog/view-shared-dialog.operation'

// 3. Type re-exports
export type { CreateDialogShareResult } from './create-dialog-share/create-dialog-share.types'
export { CreateDialogShareOperationErrorCode } from './create-dialog-share/create-dialog-share.types'
export type { GetDialogShareResult } from './get-dialog-share/get-dialog-share.types'
export { GetDialogShareOperationErrorCode } from './get-dialog-share/get-dialog-share.types'
export type { RevokeDialogShareResult } from './revoke-dialog-share/revoke-dialog-share.types'
export { RevokeDialogShareOperationErrorCode } from './revoke-dialog-share/revoke-dialog-share.types'
export type { ViewSharedDialogResult } from './view-shared-dialog/view-shared-dialog.types'
export { ViewSharedDialogOperationErrorCode } from './view-shared-dialog/view-shared-dialog.types'
export type { OwnedDialogShareDTO, SharedDialogDTO } from './shared/dialog-share.dto'

// 4. Union type
import type { CreateDialogShareOperation } from './create-dialog-share/create-dialog-share.operation'
import type { GetDialogShareOperation } from './get-dialog-share/get-dialog-share.operation'
import type { RevokeDialogShareOperation } from './revoke-dialog-share/revoke-dialog-share.operation'
import type { ViewSharedDialogOperation } from './view-shared-dialog/view-shared-dialog.operation'

export type DialogSharesOperations =
  | CreateDialogShareOperation
  | GetDialogShareOperation
  | RevokeDialogShareOperation
  | ViewSharedDialogOperation

// 5. Facade
export class DialogSharesProcess implements IDialogSharesProcess {
  async execute<T extends DialogSharesOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: DialogSharesOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IDialogSharesProcess {
  execute<T extends DialogSharesOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const dialogSharesProcess: IDialogSharesProcess = new DialogSharesProcess()
