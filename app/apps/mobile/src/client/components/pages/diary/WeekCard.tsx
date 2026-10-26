import { Button, Preloader } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useEffect, useState } from 'react'
import { DiaryApiErrorCode, WEEK_SUMMARY_MIN_DAYS, type DiaryApiResponse } from '@ryadom/contracts/api/diary'
import { createWeekSummary } from '../../../lib/api'
import { diary } from '../../../lib/diary'

/** While the card is on screen the diary is asked again this often: the text is written in the background. */
const POLL_MS = 30_000

/**
 * «Итоги недели»: the text is written by the agent in the background once three days are marked and
 * rewritten (at most every six hours) after the mood changes; the card shows it. «Обновить итоги» is the way to
 * rewrite it now, once there is a text.
 */
export default function WeekCard({ data, f7router }: { data: DiaryApiResponse; f7router: Router.Router }) {
  const { week } = data
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const heavy = (week.summary?.hardDays ?? 0) >= 3
  const enough = week.markedDays >= WEEK_SUMMARY_MIN_DAYS

  useEffect(() => {
    if (!enough) return
    const timer = setInterval(() => {
      if (!document.hidden) void diary.refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [enough])

  async function refresh() {
    setBusy(true)
    setError('')
    try {
      const outcome = await createWeekSummary({ weekStart: week.start })
      if (outcome.ok) await diary.refresh()
      else if (outcome.code === DiaryApiErrorCode.TOO_SOON) setError('Подожди немного — итоги уже обновлялись. Попробуй через несколько минут')
      else setError('Не получилось обновить итоги. Попробуй позже')
    } catch {
      setError('Не получилось обновить итоги. Попробуй позже')
    } finally {
      setBusy(false)
    }
  }

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
      {(busy || (enough && !week.summary)) && (
        <p className="rd-week-building" data-testid="diary-week-busy">
          <Preloader size={18} />
          <span>Собираю итоги…</span>
        </p>
      )}
      {enough && week.summary && !busy && (
        <Button small round outline data-testid="diary-week-refresh" onClick={() => void refresh()}>
          Обновить итоги
        </Button>
      )}
      {error && (
        <p className="rd-form-error" data-testid="diary-week-error">
          {error}
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
