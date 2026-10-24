// 1. Handler imports
import './commands/create-dialog-share/create-dialog-share.handler'
import './commands/revoke-dialog-share/revoke-dialog-share.handler'
import './commands/delete-user-dialog-shares/delete-user-dialog-shares.handler'
import './commands/record-dialog-share-view/record-dialog-share-view.handler'
import './queries/get-active-dialog-share/get-active-dialog-share.handler'
import './queries/find-dialog-share-by-token/find-dialog-share-by-token.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { CreateDialogShareCommand } from './commands/create-dialog-share/create-dialog-share.command'
export type { CreateDialogShareCommandData } from './commands/create-dialog-share/create-dialog-share.command'
export { RevokeDialogShareCommand } from './commands/revoke-dialog-share/revoke-dialog-share.command'
export type { RevokeDialogShareCommandData } from './commands/revoke-dialog-share/revoke-dialog-share.command'
export { DeleteUserDialogSharesCommand } from './commands/delete-user-dialog-shares/delete-user-dialog-shares.command'
export type { DeleteUserDialogSharesCommandData } from './commands/delete-user-dialog-shares/delete-user-dialog-shares.command'
export { RecordDialogShareViewCommand } from './commands/record-dialog-share-view/record-dialog-share-view.command'
export type { RecordDialogShareViewCommandData } from './commands/record-dialog-share-view/record-dialog-share-view.command'
export { GetActiveDialogShareQuery } from './queries/get-active-dialog-share/get-active-dialog-share.query'
export type { GetActiveDialogShareQueryData } from './queries/get-active-dialog-share/get-active-dialog-share.query'
export { FindDialogShareByTokenQuery } from './queries/find-dialog-share-by-token/find-dialog-share-by-token.query'
export type { FindDialogShareByTokenQueryData } from './queries/find-dialog-share-by-token/find-dialog-share-by-token.query'

// 3. Type re-exports
export type { CreateDialogShareCommandResult } from './commands/create-dialog-share/create-dialog-share.types'
export { CreateDialogShareCommandErrorCode } from './commands/create-dialog-share/create-dialog-share.types'
export type { RevokeDialogShareCommandResult } from './commands/revoke-dialog-share/revoke-dialog-share.types'
export type { DeleteUserDialogSharesCommandResult } from './commands/delete-user-dialog-shares/delete-user-dialog-shares.types'
export type { RecordDialogShareViewCommandResult } from './commands/record-dialog-share-view/record-dialog-share-view.types'
export type { GetActiveDialogShareQueryResult } from './queries/get-active-dialog-share/get-active-dialog-share.types'
export type { FindDialogShareByTokenQueryResult } from './queries/find-dialog-share-by-token/find-dialog-share-by-token.types'
export type { DialogShareDTO } from './shared/dialog-share.dto'

// 4. Union type
import type { CreateDialogShareCommand } from './commands/create-dialog-share/create-dialog-share.command'
import type { RevokeDialogShareCommand } from './commands/revoke-dialog-share/revoke-dialog-share.command'
import type { DeleteUserDialogSharesCommand } from './commands/delete-user-dialog-shares/delete-user-dialog-shares.command'
import type { RecordDialogShareViewCommand } from './commands/record-dialog-share-view/record-dialog-share-view.command'
import type { GetActiveDialogShareQuery } from './queries/get-active-dialog-share/get-active-dialog-share.query'
import type { FindDialogShareByTokenQuery } from './queries/find-dialog-share-by-token/find-dialog-share-by-token.query'

export type DialogSharesManagerRequests =
  | CreateDialogShareCommand
  | RevokeDialogShareCommand
  | DeleteUserDialogSharesCommand
  | RecordDialogShareViewCommand
  | GetActiveDialogShareQuery
  | FindDialogShareByTokenQuery

// 5. Facade
export class DialogSharesManager implements IDialogSharesManager {
  async execute<T extends DialogSharesManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: DialogSharesManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IDialogSharesManager {
  execute<T extends DialogSharesManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never>
}

export const dialogSharesManager: IDialogSharesManager = new DialogSharesManager()
