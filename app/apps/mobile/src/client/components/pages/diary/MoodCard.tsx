import { AnalyticsEvent } from '@ryadom/analytics/events'
import { track } from '@ryadom/analytics/browser'
import { Button } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useState } from 'react'
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
  // With a factor chosen the strip folds into one line; a tap on it opens the strip again.
  const [editingFactor, setEditingFactor] = useState(false)
  const showStrip = today !== null && (today.factor === null || editingFactor)

  function chooseMood(mood: MoodLevel) {
    void diary.mark(mood, today?.factor ?? null)
  }

  function chooseFactor(factor: MoodFactor) {
    if (!today) return
    // The same factor again takes it off.
    void diary.mark(today.mood, today.factor === factor ? null : factor)
    setEditingFactor(false)
  }

  return (
    <section className="rd-card rd-mood-card" data-testid="diary-mood-card" aria-labelledby="diary-today-title">
      <div className="rd-mood-head">
        <h2 className="rd-card-title" id="diary-today-title" data-testid="diary-today-title">
          {today ? `Сегодня: ${MOOD_LABELS[today.mood].toLowerCase()}` : 'Как ты сегодня?'}
        </h2>
        {data.streak >= 1 && (
          // Only the number (owner's exception to REQ-PRD-04): no rewards, no warning about losing it.
          <span className="rd-streak" data-testid="diary-streak">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" className="rd-streak-flame">
              <path
                d="M12 2c.6 3.2-1.4 4.8-2.9 6.6C7.6 10.4 6 12.3 6 15a6 6 0 0 0 12 0c0-2.2-1-3.9-2.2-5.2-.3 1.2-.9 2-1.8 2.4.6-3.6-.4-7.7-2-10.2Z"
                fill="currentColor"
              />
            </svg>
            {data.streak} дн.
          </span>
        )}
      </div>
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

      {today && !showStrip && (
        <button type="button" className="rd-mood-factor-line" data-testid="diary-factor-line" onClick={() => setEditingFactor(true)}>
          Повлияло: {FACTOR_LABELS[today.factor!].toLowerCase()}
        </button>
      )}

      {today && showStrip && (
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
          <div className="rd-bridge-actions">
            <Button small round fill data-testid="diary-bridge-talk" onClick={() => {
                track(AnalyticsEvent.MoodBridgeClicked, { target: 'dialog' })
                startTalk()
              }}>
              Поговорить
            </Button>
            {bridge === 'hard-streak' && (
              <Button small round outline data-testid="diary-bridge-people" onClick={() => {
                  track(AnalyticsEvent.MoodBridgeClicked, { target: 'people' })
                  f7router.navigate('/people/')
                }}>
                Люди рядом
              </Button>
            )}
          </div>
        </div>
      )}

      {/* The line «Напоминать о настроении» goes here: PROTEUS-243 (add-notifications). */}
    </section>
  )
}
