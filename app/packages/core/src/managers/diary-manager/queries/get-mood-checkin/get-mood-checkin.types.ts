import type { MoodCheckinDTO, DiarySummaryDTO } from '../../shared/diary.dto'
export type GetMoodCheckinQueryResult = { success: true; checkin: MoodCheckinDTO | null }
