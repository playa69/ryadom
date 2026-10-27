import type { SelfCheckResultDTO } from '../../../managers/self-check-manager'
export enum ListSelfCheckResultsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type ListSelfCheckResultsResult =
  | { success: true; results: SelfCheckResultDTO[]; nextBefore: Date | null }
  | { success: false; error: ListSelfCheckResultsOperationErrorCode }
