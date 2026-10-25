'use client'

import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { DiaryApiErrorCode, WEEK_SUMMARY_MIN_DAYS, type DiaryApiResponse } from '@ryadom/contracts/api/diary'
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { useClient } from '@/lib/auth'
import { BUTTON } from '../controls'

type Week = DiaryApiResponse['week']

const FAILED = 'Не получилось собрать итоги. Попробуй позже'

/**
 * "Итоги недели": under 3 marked days it says how many there are; from 3 it offers to collect the
 * text (once a day); the text is written by the agent and kept by the app. A heavy week (three hard
 * days) adds the way to people nearby.
 */
export default function WeekCard({
  week,
  heavyWeek,
  onSummary,
}: {
  week: Week
  heavyWeek: boolean
  onSummary(summary: NonNullable<Week['summary']>): void
}) {
  const client = useClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const summary = week.summary
  const collectedToday = summary
    ? new Date(summary.generatedAt).toDateString() === new Date().toDateString()
    : false

  async function collect() {
    setBusy(true)
    setError(null)
    try {
      const result = await client.createWeekSummary({ weekStart: week.start })
      if (result.ok) onSummary(result.data)
      else if (result.code === DiaryApiErrorCode.NOT_ENOUGH_DAYS) setError(FAILED)
      else setError(FAILED)
    } catch {
      setError(FAILED)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="gap-3 rounded-lg px-5 py-5 shadow-none" data-testid="diary-week-card">
      <h2 className="text-lg font-semibold text-foreground">Итоги недели</h2>
      {summary && (
        <p
          className="text-[0.9375rem] leading-[1.6] whitespace-pre-line text-foreground"
          data-testid="diary-week-text"
        >
          {summary.text}
        </p>
      )}
      {!summary && week.markedDays < WEEK_SUMMARY_MIN_DAYS && (
        <p className="text-[0.9375rem] leading-snug text-dim" data-testid="diary-week-hint">
          Отметь настроение хотя бы 3 дня на этой неделе (сейчас: {week.markedDays}) — и я соберу для тебя
          итоги
        </p>
      )}
      {busy && (
        <p
          className="flex items-center gap-2.5 text-[0.9375rem] font-medium text-foreground"
          role="status"
          data-testid="diary-week-busy"
        >
          <Loader2 aria-hidden="true" className="size-5 animate-spin text-brand-400" />
          Собираю итоги…
        </p>
      )}
      {!busy && week.markedDays >= WEEK_SUMMARY_MIN_DAYS && !collectedToday && (
        <div>
          <Button
            size="sm"
            className={BUTTON}
            data-testid="diary-week-collect"
            onClick={() => void collect()}
          >
            Собрать итоги недели
          </Button>
        </div>
      )}
      {summary && heavyWeek && (
        <div>
          <Button asChild size="sm" variant="outline" className={BUTTON}>
            <Link href="/people" data-testid="diary-week-people">
              Люди рядом
            </Link>
          </Button>
        </div>
      )}
      {error && (
        <p role="status" className="text-sm text-danger" data-testid="diary-week-error">
          {error}
        </p>
      )}
    </Card>
  )
}
