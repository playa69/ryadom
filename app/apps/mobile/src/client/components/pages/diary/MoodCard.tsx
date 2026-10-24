import { Button } from 'framework7-react'
import type { Router } from 'framework7/types'
import {
  FACTOR_LABELS,
  MOOD_FACTORS,
  MOOD_LABELS,
  MOOD_LEVELS,
  bridgeFor,
} from '@ryadom/client-core/diary'
import type { DiaryApiResponse, MoodFactor, MoodLevel } from '@ryadom/contracts/api/diary'
import { diary } from '../../../lib/diary'
import { deviceDate, previousDate } from '../../../lib/diary-queue'
import { startTalk } from '../../../lib/nav'
import MoodFace from './MoodFace'
import ReminderBlock from './ReminderBlock'

/** Days of «Тяжело» in a row ending today, from the month read (a streak across months is not counted). */
export function hardStreak(month: DiaryApiResponse['month'], today: string): number {
  const hard = new Set(month.filter((d) => d.mood === 1).map((d) => d.date))
  let count = 0
  for (let day = today; hard.has(day); day = previousDate(day)) count += 1
  return count
}

/**
 * «Как ты сегодня?»: five faces and, once one is chosen, one factor. A tap saves at once; the day has one
 * note and a new choice replaces it. The bridge to a conversation follows a heavy day. The value of the
 * mood goes nowhere but the server (never to the agent, never to analytics).
 */
export default function MoodCard({ data, f7router }: { data: DiaryApiResponse; f7router: Router.Router }) {
  const today = data.today
  const streak = today ? hardStreak(data.month, deviceDate()) : 0
  const bridge = today ? bridgeFor(today.mood, streak) : null

  function chooseMood(mood: MoodLevel) {
    void diary.mark(mood, today?.factor ?? null)
  }

  function chooseFactor(factor: MoodFactor) {
    if (!today) return
    // The same factor again takes it off.
    void diary.mark(today.mood, today.factor === factor ? null : factor)
  }

  return (
    <section className="rd-card rd-mood-card" data-testid="diary-mood-card" aria-labelledby="diary-today-title">
      <h2 className="rd-card-title" id="diary-today-title" data-testid="diary-today-title">
        {today ? `Сегодня: ${MOOD_LABELS[today.mood].toLowerCase()}` : 'Как ты сегодня?'}
      </h2>
      <div className="rd-mood-faces" role="group" aria-label="Настроение сегодня">
        {MOOD_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            className={`rd-mood-face${today?.mood === level ? ' rd-mood-face--on' : ''}${today && today.mood !== level ? ' rd-mood-face--dim' : ''}`}
            aria-pressed={today?.mood === level}
            aria-label={MOOD_LABELS[level]}
            data-testid={`diary-mood-${level}`}
            onClick={() => chooseMood(level)}
          >
            <MoodFace level={level} />
            <span className="rd-mood-face-label">{MOOD_LABELS[level]}</span>
          </button>
        ))}
      </div>

      {today && (
        <div className="rd-mood-factors" data-testid="diary-factors">
          <p className="rd-mood-factors-title">Что повлияло больше всего?</p>
          <div className="rd-factor-strip" role="group" aria-label="Что повлияло">
            {MOOD_FACTORS.map((factor) => (
              <button
                key={factor}
                type="button"
                className={`rd-factor${today.factor === factor ? ' rd-factor--on' : ''}`}
                aria-pressed={today.factor === factor}
                data-testid={`diary-factor-${factor}`}
                onClick={() => chooseFactor(factor)}
              >
                {FACTOR_LABELS[factor]}
              </button>
            ))}
          </div>
        </div>
      )}

      {bridge && (
        <div className="rd-bridge" data-testid="diary-bridge">
          <p className="rd-bridge-text">
            {bridge === 'hard-streak'
              ? 'Похоже, сейчас непросто. Можно поговорить со мной или с теми, кто рядом'
              : 'Хочешь рассказать, что случилось?'}
          </p>
          <div className="rd-reminder-actions">
            <Button small round fill data-testid="diary-bridge-talk" onClick={() => startTalk()}>
              Поговорить
            </Button>
            {bridge === 'hard-streak' && (
              <Button small round outline data-testid="diary-bridge-people" onClick={() => f7router.navigate('/people/')}>
                Люди рядом
              </Button>
            )}
          </div>
        </div>
      )}

      <ReminderBlock reminder={data.reminder} />
    </section>
  )
}
