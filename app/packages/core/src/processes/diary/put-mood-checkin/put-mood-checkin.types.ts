import type { MoodCheckinDTO } from '../../../managers/diary-manager'
export enum PutMoodCheckinOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  DATE_OUT_OF_RANGE = 'DATE_OUT_OF_RANGE',
}

export type PutMoodCheckinResult =
  | { success: true; checkin: MoodCheckinDTO; changed: boolean; hardStreak: number }
  | { success: false; error: PutMoodCheckinOperationErrorCode }
