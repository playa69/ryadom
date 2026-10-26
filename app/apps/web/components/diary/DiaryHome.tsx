'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { moodInsight, parseDate } from '@ryadom/client-core/diary'
import type { DiaryApiResponse } from '@ryadom/contracts/api/diary'
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { Skeleton } from '@ryadom/ui/components/skeleton'
import { useClient } from '@/lib/auth'
import { deviceToday, useLoaded } from '@/lib/diary'
import { RetryButton, StatePanel } from '../JournalParts'
import SelfCheckBlock from '../self-check/SelfCheckBlock'
import MoodCard from './MoodCard'
import { BUTTON } from '../controls'
import RollingChart from './RollingChart'
import WeekCard from './WeekCard'

/** Segment «Дневник»: the mood card, the 28-day chart, the week summary and last week's summary, top to bottom. */
export default function DiaryHome() {
  const client = useClient()
  const today = deviceToday()
  const { state, reload, set } = useLoaded(() => client.getDiary(), today)

  const data = state.status === 'ready' ? state.data : null
  const insight = useMemo(() => (data ? moodInsight(data.recent) : null), [data])

  if (state.status === 'error') {
    return (
      <StatePanel>
        <p className="text-base text-dim">Не получилось загрузить дневник</p>
        <RetryButton onClick={reload} />
      </StatePanel>
    )
  }
  if (!data) return <Skeleton className="h-64 w-full rounded-lg" aria-busy="true" />

  function setToday(next: NonNullable<DiaryApiResponse['today']>) {
    set((d) => {
      const entry = { date: today, mood: next.mood, factor: next.factor }
      const recent = [...d.recent.filter((e) => e.date !== today), entry].sort((a, b) =>
        a.date < b.date ? -1 : 1,
      )
      const wasMarked = d.today !== null
      return {
        ...d,
        today: next,
        recent,
        // The first note of the day extends the run by one (it counts back from yesterday until then).
        streak: wasMarked ? d.streak : d.streak + 1,
        week: { ...d.week, markedDays: wasMarked ? d.week.markedDays : d.week.markedDays + 1 },
      }
    })
  }

  return (
    <>
      <MoodCard today={data.today} streak={data.streak} onChange={setToday} />
      <RollingChart recent={data.recent} today={today} insight={insight} />
      <WeekCard week={data.week} onPoll={reload} />
      {data.previousWeek && (
        <Card className="gap-3 rounded-lg px-5 py-5 shadow-none" data-testid="diary-previous-week">
          <h2 className="text-lg font-semibold text-foreground">Итоги прошлой недели</h2>
          <p className="text-[0.9375rem] leading-[1.55] whitespace-pre-line text-foreground">{data.previousWeek.text}</p>
          {data.previousWeek.hardDays >= 3 && (
            <div>
              <Button asChild size="sm" variant="outline" className={BUTTON}>
                <Link href="/people" data-testid="diary-previous-week-people">
                  Люди рядом
                </Link>
              </Button>
            </div>
          )}
        </Card>
      )}
      <SelfCheckBlock />
    </>
  )
}

function addDays(date: string, days: number): [number, number, number] {
  const { year, month, day } = parseDate(date)
  const d = new Date(Date.UTC(year, month - 1, day + days))
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
}
