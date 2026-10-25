import { Button, Preloader } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useState } from 'react'
import { WEEK_SUMMARY_MIN_DAYS, type DiaryApiResponse } from '@ryadom/contracts/api/diary'
import { createWeekSummary } from '../../../lib/api'
import { diary } from '../../../lib/diary'
import { deviceDate } from '../../../lib/diary-queue'

/**
 * «Итоги недели»: waits for three marked days, then one button; the text is the agent's, the app keeps it.
 * One build a day: a text from today leaves no button. A failed build does not use the day up.
 */
export default function WeekCard({ data, f7router }: { data: DiaryApiResponse; f7router: Router.Router }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { week } = data
  const heavy = data.recent.filter((d) => d.date >= week.start && d.mood === 1).length >= 3
  const builtToday = week.summary !== null && deviceDate(new Date(week.summary.generatedAt)) === deviceDate()
  const enough = week.markedDays >= WEEK_SUMMARY_MIN_DAYS

  async function collect() {
    setBusy(true)
    setError('')
    try {
      const outcome = await createWeekSummary({ weekStart: week.start })
      if (!outcome.ok) setError('Не получилось собрать итоги. Попробуй позже')
      else await diary.refresh()
    } catch {
      setError('Не получилось собрать итоги. Попробуй позже')
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
      {!week.summary && !enough && (
        <p className="rd-muted" data-testid="diary-week-waiting">
          Отметь настроение хотя бы 3 дня на этой неделе (сейчас: {week.markedDays}) — и я соберу для тебя итоги
        </p>
      )}
      {busy && (
        <p className="rd-week-building" data-testid="diary-week-busy">
          <Preloader size={18} />
          <span>Собираю итоги…</span>
        </p>
      )}
      {enough && !builtToday && !busy && (
        <Button
          small
          round
          fill={!week.summary}
          outline={week.summary !== null}
          data-testid="diary-week-collect"
          onClick={() => void collect()}
        >
          {week.summary ? 'Собрать заново' : 'Собрать итоги недели'}
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
