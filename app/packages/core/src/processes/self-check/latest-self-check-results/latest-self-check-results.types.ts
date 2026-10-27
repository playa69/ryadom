import type { SelfCheckResultDTO } from '../../../managers/self-check-manager'
export enum LatestSelfCheckResultsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type LatestSelfCheckResultsResult =
  | { success: true; results: SelfCheckResultDTO[] }
  | { success: false; error: LatestSelfCheckResultsOperationErrorCode }
