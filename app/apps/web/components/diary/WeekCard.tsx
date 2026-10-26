'use client'

import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import { useEffect } from 'react'
import { WEEK_SUMMARY_MIN_DAYS, type DiaryApiResponse } from '@ryadom/contracts/api/diary'
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { BUTTON } from '../controls'

type Week = DiaryApiResponse['week']

/** While the card is on screen the diary is asked again this often: the text is written in the background. */
const POLL_MS = 30_000

/**
 * "Итоги недели": under 3 marked days it says how many there are; from 3 the agent writes the text in
 * the background (and rewrites it after the mood changes), the card only shows it. A heavy week (three
 * hard days) adds the way to people nearby.
 */
export default function WeekCard({ week, onPoll }: { week: Week; onPoll(): void }) {
  const summary = week.summary
  const heavyWeek = (summary?.hardDays ?? 0) >= 3
  const enough = week.markedDays >= WEEK_SUMMARY_MIN_DAYS

  useEffect(() => {
    if (!enough) return
    const timer = setInterval(() => {
      if (!document.hidden) onPoll()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [enough, onPoll])

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
      {!enough && (
        <p className="text-[0.9375rem] leading-snug text-dim" data-testid="diary-week-hint">
          Итоги недели появятся, когда отметишь {WEEK_SUMMARY_MIN_DAYS} дня (сейчас: {week.markedDays} из{' '}
          {WEEK_SUMMARY_MIN_DAYS})
        </p>
      )}
      {enough && !summary && (
        <p
          className="flex items-center gap-2.5 text-[0.9375rem] font-medium text-foreground"
          role="status"
          data-testid="diary-week-busy"
        >
          <Loader2 aria-hidden="true" className="size-5 animate-spin text-brand-400" />
          Собираю итоги…
        </p>
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
    </Card>
  )
}
