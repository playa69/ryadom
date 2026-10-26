import { Button, Preloader } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useEffect } from 'react'
import { WEEK_SUMMARY_MIN_DAYS, type DiaryApiResponse } from '@ryadom/contracts/api/diary'
import { diary } from '../../../lib/diary'

/** While the card is on screen the diary is asked again this often: the text is written in the background. */
const POLL_MS = 30_000

/**
 * «Итоги недели»: the text is written by the agent in the background once three days are marked and
 * rewritten after the mood changes; the app only shows it. No button.
 */
export default function WeekCard({ data, f7router }: { data: DiaryApiResponse; f7router: Router.Router }) {
  const { week } = data
  const heavy = (week.summary?.hardDays ?? 0) >= 3
  const enough = week.markedDays >= WEEK_SUMMARY_MIN_DAYS

  useEffect(() => {
    if (!enough) return
    const timer = setInterval(() => {
      if (!document.hidden) void diary.refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [enough])

  return (
    <section className="rd-card rd-week-card" data-testid="diary-week-card" aria-labelledby="diary-week-title">
      <h2 className="rd-card-title" id="diary-week-title">
        Итоги недели
      </h2>
      {week.summary && (
        <p className="rd-summary-text" data-testid="diary-week-text">
          {week.summary.text}
        </p>
      )}
      {!enough && (
        <p className="rd-muted" data-testid="diary-week-waiting">
          Итоги недели появятся, когда отметишь {WEEK_SUMMARY_MIN_DAYS} дня (сейчас: {week.markedDays} из{' '}
          {WEEK_SUMMARY_MIN_DAYS})
        </p>
      )}
      {enough && !week.summary && (
        <p className="rd-week-building" data-testid="diary-week-busy">
          <Preloader size={18} />
          <span>Собираю итоги…</span>
        </p>
      )}
      {week.summary && heavy && (
        <Button small round outline data-testid="diary-week-people" onClick={() => f7router.navigate('/people/')}>
          Люди рядом
        </Button>
      )}
    </section>
  )
}
