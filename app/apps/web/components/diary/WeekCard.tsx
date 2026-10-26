'use client'

import { Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DiaryApiErrorCode, WEEK_SUMMARY_MIN_DAYS, type DiaryApiResponse } from '@ryadom/contracts/api/diary'
import { Card } from '@ryadom/ui/components/card'
import { useClient } from '@/lib/auth'

type Week = DiaryApiResponse['week']

/** While the card is on screen the diary is asked again this often: the text is written in the background. */
const POLL_MS = 30_000

/**
 * "Итоги недели": under 3 marked days it says how many there are; from 3 the agent writes the text in
 * the background (and rewrites it, at most every six hours, after the mood changes); «Обновить итоги» rewrites it now.
 */
export default function WeekCard({ week, onPoll }: { week: Week; onPoll(): void }) {
  const client = useClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const summary = week.summary
  const enough = week.markedDays >= WEEK_SUMMARY_MIN_DAYS

  useEffect(() => {
    if (!enough) return
    const timer = setInterval(() => {
      if (!document.hidden) onPoll()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [enough, onPoll])

  async function refresh() {
    setBusy(true)
    setError(null)
    try {
      const result = await client.createWeekSummary({ weekStart: week.start })
      if (result.ok) onPoll()
      else if (result.code === DiaryApiErrorCode.TOO_SOON) setError('Подожди немного — итоги уже обновлялись. Попробуй через несколько минут')
      else setError('Не получилось обновить итоги. Попробуй позже')
    } catch {
      setError('Не получилось обновить итоги. Попробуй позже')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="gap-3 rounded-lg px-5 py-5 shadow-none" data-testid="diary-week-card">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">Итоги недели</h2>
        {enough && summary && !busy && (
          <button
            type="button"
            className="-my-3 -mr-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-[0.8125rem] text-faint transition-colors hover:text-foreground focus-visible:text-foreground"
            data-testid="diary-week-refresh"
            aria-label="Обновить итоги"
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Обновить
          </button>
        )}
      </div>
      {summary && (
        <p
          className="text-[0.9375rem] leading-[1.6] whitespace-pre-line text-foreground"
          data-testid="diary-week-text"
        >
          {summary.text}
        </p>
      )}
      {!enough && (
        <p className="text-[0.9375rem] leading-snug text-dim" data-testid="diary-week-hint">
          Итоги недели появятся, когда отметишь {WEEK_SUMMARY_MIN_DAYS} дня (сейчас: {week.markedDays} из{' '}
          {WEEK_SUMMARY_MIN_DAYS})
        </p>
      )}
      {(busy || (enough && !summary)) && (
        <p
          className="flex items-center gap-2.5 text-[0.9375rem] font-medium text-foreground"
          role="status"
          data-testid="diary-week-busy"
        >
          <Loader2 aria-hidden="true" className="size-5 animate-spin text-brand-400" />
          Собираю итоги…
        </p>
      )}
      {error && (
        <p role="status" className="text-sm text-danger" data-testid="diary-week-error">
          {error}
        </p>
      )}
    </Card>
  )
}
