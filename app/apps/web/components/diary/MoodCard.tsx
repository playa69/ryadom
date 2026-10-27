'use client'

import { AnalyticsEvent } from '@ryadom/analytics/events'
import { track } from '@ryadom/analytics/browser'
import { Flame } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { FACTOR_LABELS, MOOD_FACTORS, MOOD_LABELS, MOOD_LEVELS, bridgeFor } from '@ryadom/client-core/diary'
import { apiErrorText } from '@ryadom/client-core/errors'
import type { DiaryApiResponse, MoodFactor, MoodLevel } from '@ryadom/contracts/api/diary'
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { cn } from '@ryadom/ui/lib/utils'
import { useClient } from '@/lib/auth'
import { BUTTON } from '../controls'
import { MoodFace } from './MoodFace'

type Today = DiaryApiResponse['today']

/**
 * "Как ты сегодня?": five levels, then one factor. A tap on a level saves the day at once (a new tap
 * replaces it, the factor stays); a tap on a factor saves it and folds the strip into «Повлияло: …»
 * (a tap on that line opens it again, where a second tap on the factor takes it off). The value
 * stays in this component and the server: it goes to no analytics event and to no log.
 */
export default function MoodCard({
  today,
  streak,
  onChange,
}: {
  today: Today
  /** Days in a row with a note, up to today (or up to yesterday while today is not marked). */
  streak: number
  onChange(today: NonNullable<Today>): void
}) {
  const client = useClient()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [hardStreak, setHardStreak] = useState(0)
  const [busy, setBusy] = useState(false)
  // The factor strip folds into «Повлияло: …» once a factor is chosen; a tap on the line opens it again.
  const [editingFactor, setEditingFactor] = useState(false)

  async function save(mood: MoodLevel, factor: MoodFactor | null) {
    const before = today
    setError(null)
    setBusy(true)
    onChange({ mood, factor })
    try {
      const result = await client.putMoodCheckin({ mood, factor, source: 'app' })
      if (result.ok) {
        setHardStreak(result.data.hardStreak)
      } else {
        if (before) onChange(before)
        setError('Не получилось сохранить отметку. Попробуй ещё раз')
      }
    } catch (e) {
      if (before) onChange(before)
      setError(apiErrorText(e, {}, 'Не получилось сохранить отметку. Попробуй ещё раз'))
    } finally {
      setBusy(false)
    }
  }

  const bridge = today ? bridgeFor(today.mood, hardStreak) : null

  return (
    <Card className="gap-5 rounded-lg px-5 py-5 shadow-none" data-testid="diary-mood-card">
      <div className="flex items-center gap-3">
        <h2 className="min-w-0 flex-1 text-lg font-semibold text-foreground" data-testid="diary-today-title">
          {today ? `Сегодня: ${MOOD_LABELS[today.mood].toLowerCase()}` : 'Как ты сегодня?'}
        </h2>
        {/* A plain counter, no rewards and no warnings (an owner-approved exception to REQ-PRD-04). */}
        {streak > 0 && (
          <span
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/8 px-3 py-1.5 text-sm font-bold text-[#ffb347]"
            data-testid="diary-streak"
          >
            <Flame aria-hidden="true" className="size-4" />
            {streak} дн.
          </span>
        )}
      </div>

      <div role="group" aria-label="Настроение сегодня" className="grid grid-cols-5 gap-1.5">
        {MOOD_LEVELS.map((level) => {
          const selected = today?.mood === level
          return (
            <button
              key={level}
              type="button"
              data-testid={`diary-mood-${level}`}
              aria-pressed={selected}
              disabled={busy}
              onClick={() => void save(level, today?.factor ?? null)}
              className={cn(
                BUTTON,
                'relative flex min-h-20 flex-col items-center gap-1.5 rounded-lg px-1 py-2 text-xs font-medium text-dim transition-colors hover:bg-white/5',
                selected && 'font-bold text-foreground',
              )}
            >
              {/* The chosen face keeps its colour and wears a check (readable without colour); the rest go grey. */}
              {selected && (
                <span
                  aria-hidden="true"
                  className="absolute top-1 left-[calc(50%+9px)] flex size-[18px] items-center justify-center rounded-full bg-foreground text-xs font-extrabold leading-none text-[#0c1438]"
                >
                  ✓
                </span>
              )}
              <MoodFace mood={level} muted={today !== null && !selected} />
              <span className="whitespace-nowrap max-[360px]:text-[10px]">{MOOD_LABELS[level]}</span>
            </button>
          )
        })}
      </div>

      {today && today.factor && !editingFactor && (
        <button
          type="button"
          data-testid="diary-factor-summary"
          className={cn(BUTTON, 'self-start text-left text-sm font-semibold text-dim')}
          onClick={() => setEditingFactor(true)}
        >
          Повлияло: {FACTOR_LABELS[today.factor].toLowerCase()}
        </button>
      )}

      {today && (!today.factor || editingFactor) && (
        <div className="flex flex-col gap-2.5" data-testid="diary-factors">
          <p className="text-sm font-semibold text-dim">Что повлияло больше всего?</p>
          <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Что повлияло">
            {MOOD_FACTORS.map((factor) => {
              const selected = today.factor === factor
              return (
                <button
                  key={factor}
                  type="button"
                  data-testid={`diary-factor-${factor}`}
                  aria-pressed={selected}
                  disabled={busy}
                  onClick={() => {
                    // Choosing folds the strip; taking the factor off keeps it open.
                    if (!selected) setEditingFactor(false)
                    void save(today.mood, selected ? null : factor)
                  }}
                  className={cn(
                    BUTTON,
                    'h-10 shrink-0 rounded-full border border-line px-4 text-sm font-medium text-dim transition-colors hover:bg-white/5',
                    selected && 'border-brand-line bg-brand-soft text-foreground',
                  )}
                >
                  {FACTOR_LABELS[factor]}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {bridge && (
        <div
          className="flex flex-col gap-3 rounded-lg border border-line bg-white/4 p-4"
          data-testid="diary-bridge"
        >
          <p className="text-[0.9375rem] leading-snug text-foreground">
            {bridge === 'hard-streak'
              ? 'Похоже, сейчас непросто. Можно поговорить со мной или с теми, кто рядом'
              : 'Хочешь рассказать, что случилось?'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              className={BUTTON}
              data-testid="diary-bridge-talk"
              onClick={() => {
                track(AnalyticsEvent.MoodBridgeClicked, { target: 'dialog' })
                router.push('/home')
              }}
            >
              Поговорить
            </Button>
            {bridge === 'hard-streak' && (
              <Button
                size="sm"
                variant="outline"
                className={BUTTON}
                data-testid="diary-bridge-people"
                onClick={() => {
                  track(AnalyticsEvent.MoodBridgeClicked, { target: 'people' })
                  router.push('/people')
                }}
              >
                Люди рядом
              </Button>
            )}
          </div>
        </div>
      )}

      {error && (
        <p role="status" className="text-sm text-danger">
          {error}
        </p>
      )}

      {/* The line «Напоминать о настроении» goes here: PROTEUS-243 (add-notifications). */}
    </Card>
  )
}
