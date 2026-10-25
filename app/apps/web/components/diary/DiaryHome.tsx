'use client'

import { useMemo } from 'react'
import { moodInsight, toDate, parseDate, weekStartOf } from '@ryadom/client-core/diary'
import type { DiaryApiResponse, MoodCheckinApi } from '@ryadom/contracts/api/diary'
import { Skeleton } from '@ryadom/ui/components/skeleton'
import { useClient } from '@/lib/auth'
import { deviceToday, useLoaded } from '@/lib/diary'
import { RetryButton, StatePanel } from '../JournalParts'
import EventsCard from './EventsCard'
import MoodCard from './MoodCard'
import RollingChart from './RollingChart'
import WeekCard from './WeekCard'

/** Segment «Дневник»: the mood card, the 28-day chart, the week summary and the week's events, top to bottom. */
export default function DiaryHome() {
  const client = useClient()
  const today = deviceToday()
  const { state, reload, set } = useLoaded(() => client.getDiary(), today)

  const data = state.status === 'ready' ? state.data : null
  const heavyWeek = useMemo(() => {
    if (!data) return false
    const start = data.week.start
    const end = toDate(...addDays(start, 6))
    return (
      data.recent.filter((d: MoodCheckinApi) => d.date >= start && d.date <= end && d.mood === 1).length >= 3
    )
  }, [data])
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
      <WeekCard
        week={data.week}
        heavyWeek={heavyWeek}
        onSummary={(summary) => set((d) => ({ ...d, week: { ...d.week, summary } }))}
      />
      <EventsCard weekStart={data.week.start || weekStartOf(today)} />
    </>
  )
}

function addDays(date: string, days: number): [number, number, number] {
  const { year, month, day } = parseDate(date)
  const d = new Date(Date.UTC(year, month - 1, day + days))
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
}
