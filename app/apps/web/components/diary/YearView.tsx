'use client'

import { AnalyticsEvent } from '@ryadom/analytics/events'
import { track } from '@ryadom/analytics/browser'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  MOOD_COLORS,
  MOOD_LABELS,
  MOOD_LEVELS,
  buildYearGrid,
  dayCaption,
  monthName,
  moodColor,
  parseDate,
} from '@ryadom/client-core/diary'
import { YEAR_STORY_EXTEND_WEEKS, YEAR_STORY_MIN_WEEKS, type DiaryYearApiResponse } from '@ryadom/contracts/api/diary'
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { Skeleton } from '@ryadom/ui/components/skeleton'
import { cn } from '@ryadom/ui/lib/utils'
import { useClient } from '@/lib/auth'
import { deviceToday, useLoaded } from '@/lib/diary'
import { renderYearImage, shareYearImage } from '@/lib/year-image'
import { BUTTON } from '../controls'
import { RetryButton, StatePanel } from '../JournalParts'

const DAY_LABELS = new Set([1, 5, 10, 15, 20, 25, 31])
const STORY_FAILED = 'Не получилось собрать историю. Попробуй позже'

/** Segment «Год»: the 12 × 31 grid, the legend, two plaques, the share button and the year story. */
export default function YearView() {
  const client = useClient()
  const today = deviceToday()
  const [year, setYear] = useState(parseDate(today).year)
  const { state, reload, set } = useLoaded(() => client.getDiaryYear(year), String(year))
  const [pick, setPick] = useState<string | null>(null)
  const [busy, setBusy] = useState<'share' | 'story' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const data: DiaryYearApiResponse | null = state.status === 'ready' ? state.data : null
  const grid = useMemo(() => buildYearGrid(year, data?.days ?? [], today), [year, data, today])

  if (state.status === 'error') {
    return (
      <StatePanel>
        <p className="text-base text-dim">Не получилось загрузить год</p>
        <RetryButton onClick={reload} />
      </StatePanel>
    )
  }
  if (!data) return <Skeleton className="h-64 w-full rounded-lg" aria-busy="true" />

  const picked = pick ? (data.days.find((d) => d.date === pick) ?? null) : null
  const canExtend = data.story !== null && data.weeklyCount - data.story.weeklyCount >= YEAR_STORY_EXTEND_WEEKS
  const canWrite = data.story === null && data.weeklyCount >= YEAR_STORY_MIN_WEEKS

  async function share() {
    if (!data) return
    setBusy('share')
    setNote(null)
    try {
      const blob = await renderYearImage(year, data.days, today)
      const how = await shareYearImage(year, blob)
      if (how === 'shared' || how === 'downloaded') track(AnalyticsEvent.YearShared)
      if (how === 'downloaded') setNote(`Картинка сохранена: ryadom-${year}.png`)
    } catch {
      setNote('Не получилось сделать картинку')
    } finally {
      setBusy(null)
    }
  }

  async function writeStory() {
    setBusy('story')
    setNote(null)
    try {
      const result = await client.createYearStory({ year })
      if (result.ok) set((d) => ({ ...d, story: { text: result.data.text, generatedAt: result.data.generatedAt, weeklyCount: d.weeklyCount } }))
      else setNote(STORY_FAILED)
    } catch {
      setNote(STORY_FAILED)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Card className="gap-4 rounded-lg px-4 py-5 shadow-none" data-testid="diary-year-card">
        <div className="flex items-center gap-2 px-1">
          <h2 className="min-w-0 flex-1 text-lg font-semibold text-foreground">Год в пикселях</h2>
          <Button variant="ghost" size="icon" className={BUTTON} aria-label="Предыдущий год" data-testid="diary-year-prev" onClick={() => setYear(year - 1)}>
            <ChevronLeft />
          </Button>
          <span className="min-w-12 text-center text-sm font-semibold text-dim" data-testid="diary-year-title">
            {year}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className={BUTTON}
            aria-label="Следующий год"
            data-testid="diary-year-next"
            disabled={year >= parseDate(today).year}
            onClick={() => setYear(year + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
        <p className="px-1 text-sm leading-snug text-dim">Каждый квадратик — один день. Отмечай настроение, и год раскрасится</p>

        <div className="overflow-x-auto pb-1">
          <div className="min-w-[30rem]" data-testid="diary-year-grid" role="group" aria-label={`Год ${year} в пикселях`}>
            <div className="grid grid-cols-[2.25rem_repeat(31,minmax(0,1fr))] gap-[3px] pb-1 text-[0.625rem] text-faint" aria-hidden="true">
              <span />
              {Array.from({ length: 31 }, (_, i) => (
                <span key={i} className="text-center">
                  {DAY_LABELS.has(i + 1) ? i + 1 : ''}
                </span>
              ))}
            </div>
            {grid.map((row, m) => (
              <div key={m} className="mb-[3px] grid grid-cols-[2.25rem_repeat(31,minmax(0,1fr))] gap-[3px]">
                <span className="self-center text-[0.625rem] text-faint">{monthName(m + 1).slice(0, 3)}</span>
                {row.map((cell) => (
                  <button
                    key={cell.date}
                    type="button"
                    data-testid="diary-year-cell"
                    data-date={cell.date}
                    data-mood={cell.entry?.mood ?? ''}
                    aria-label={cell.entry ? dayCaption(cell.entry) : cell.date}
                    onClick={() => setPick(cell.date)}
                    style={cell.entry ? { backgroundColor: moodColor(cell.entry.mood) } : undefined}
                    className={cn(
                      'aspect-square rounded-[3px] outline-offset-1 focus-visible:outline-2 focus-visible:outline-brand-400',
                      !cell.entry && (cell.future ? 'bg-white/5' : 'bg-white/12'),
                      pick === cell.date && 'outline-2 outline-foreground',
                    )}
                  />
                ))}
                {Array.from({ length: 31 - row.length }, (_, i) => (
                  <span key={`pad-${i}`} aria-hidden="true" />
                ))}
              </div>
            ))}
          </div>
        </div>

        <p className="min-h-5 px-1 text-sm text-foreground" aria-live="polite" data-testid="diary-year-caption">
          {picked ? dayCaption(picked) : ''}
        </p>

        <div className="flex items-center gap-2 px-1 text-xs text-dim" data-testid="diary-year-legend">
          <span>{MOOD_LABELS[1]}</span>
          {MOOD_LEVELS.map((level) => (
            <span key={level} className="size-4 rounded-[3px]" style={{ backgroundColor: MOOD_COLORS[level] }} aria-hidden="true" />
          ))}
          <span>{MOOD_LABELS[5]}</span>
        </div>

        <div className="grid grid-cols-2 gap-2.5 px-1">
          <div className="rounded-lg border border-line px-3 py-2.5" data-testid="diary-year-marked">
            <p className="text-xs text-faint">Отмечено дней</p>
            <p className="text-lg font-semibold text-foreground">{data.markedDays}</p>
          </div>
          <div className="rounded-lg border border-line px-3 py-2.5" data-testid="diary-year-most">
            <p className="text-xs text-faint">Чаще всего</p>
            <p className="text-lg font-semibold text-foreground">{data.mostFrequent ? MOOD_LABELS[data.mostFrequent].toLowerCase() : '—'}</p>
          </div>
        </div>

        <div className="px-1">
          <Button className={BUTTON} disabled={busy === 'share'} data-testid="diary-year-share" onClick={() => void share()}>
            Поделиться моим годом
          </Button>
        </div>
        {note && (
          <p role="status" className="px-1 text-sm text-dim" data-testid="diary-year-note">
            {note}
          </p>
        )}
      </Card>

      <Card className="gap-3 rounded-lg px-5 py-5 shadow-none" data-testid="diary-story-card">
        <h2 className="text-lg font-semibold text-foreground">Итоги года</h2>
        {data.story ? (
          <p className="text-[0.9375rem] leading-[1.6] whitespace-pre-line text-foreground" data-testid="diary-story-text">
            {data.story.text}
          </p>
        ) : (
          <>
            <p className="text-[0.9375rem] leading-snug text-dim">
              Каждые «Итоги недели» сохраняются сюда. Собрано {data.weeklyCount} из {YEAR_STORY_MIN_WEEKS} — когда накопится, я напишу
              большую историю твоего года
            </p>
            <div
              role="progressbar"
              aria-label="Собрано итогов недели"
              aria-valuemin={0}
              aria-valuemax={YEAR_STORY_MIN_WEEKS}
              aria-valuenow={Math.min(data.weeklyCount, YEAR_STORY_MIN_WEEKS)}
              className="h-2 overflow-hidden rounded-full bg-white/10"
              data-testid="diary-story-progress"
            >
              <div
                className="h-full rounded-full bg-brand"
                style={{ width: `${(Math.min(data.weeklyCount, YEAR_STORY_MIN_WEEKS) / YEAR_STORY_MIN_WEEKS) * 100}%` }}
              />
            </div>
          </>
        )}
        {(canExtend || canWrite) && (
          <div>
            <Button size="sm" variant="outline" className={BUTTON} disabled={busy === 'story'} data-testid="diary-story-write" onClick={() => void writeStory()}>
              {canExtend ? 'Дописать историю' : 'Собрать историю года'}
            </Button>
          </div>
        )}
      </Card>
    </>
  )
}
