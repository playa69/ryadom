'use client'

import { useMemo, useState } from 'react'
import { parseDate, toMonthKey, toDate, weekStartOf } from '@ryadom/client-core/diary'
import type { DiaryApiResponse, MoodCheckinApi } from '@ryadom/contracts/api/diary'
import { Skeleton } from '@ryadom/ui/components/skeleton'
import { useClient } from '@/lib/auth'
import { deviceToday, useLoaded } from '@/lib/diary'
import { RetryButton, StatePanel } from '../JournalParts'
import EventsCard from './EventsCard'
import MonthChart from './MonthChart'
import MoodCard from './MoodCard'
import WeekCard from './WeekCard'

/** Segment «Дневник»: the mood card, the month chart, the week summary and the week's events, top to bottom. */
export default function DiaryHome() {
  const client = useClient()
  const today = deviceToday()
  const t = parseDate(today)
  const [view, setView] = useState({ year: t.year, month: t.month })
  const key = toMonthKey(view.year, view.month)
  const isCurrent = view.year === t.year && view.month === t.month
  const { state, reload, set } = useLoaded(() => client.getDiary(key), key)

  const data = state.status === 'ready' ? state.data : null
  const heavyWeek = useMemo(() => {
    if (!data) return false
    const start = data.week.start
    const end = toDate(...(addDays(start, 6)))
    return data.month.filter((d: MoodCheckinApi) => d.date >= start && d.date <= end && d.mood === 1).length >= 3
  }, [data])

  if (state.status === 'error') {
    return (
      <StatePanel>
        <p className="text-base text-dim">Не получилось загрузить дневник</p>
        <RetryButton onClick={reload} />
      </StatePanel>
    )
  }
  if (!data) return <Skeleton className="h-64 w-full rounded-lg" aria-busy="true" />

  const todayEntry = data.today
  function setToday(next: NonNullable<DiaryApiResponse['today']>) {
    set((d) => {
      const rest = d.month.filter((e) => e.date !== today)
      const month = isCurrent ? [...rest, { date: today, mood: next.mood, factor: next.factor }].sort((a, b) => (a.date < b.date ? -1 : 1)) : d.month
      const wasMarked = d.today !== null
      return {
        ...d,
        today: next,
        month,
        week: { ...d.week, markedDays: wasMarked ? d.week.markedDays : d.week.markedDays + 1 },
      }
    })
  }

  return (
    <>
      <MoodCard today={todayEntry} onChange={setToday} />
      <MonthChart
        year={view.year}
        month={view.month}
        days={data.month}
        today={today}
        loading={false}
        onPrev={() => setView(shiftMonth(view, -1))}
        onNext={isCurrent ? undefined : () => setView(shiftMonth(view, 1))}
      />
      <WeekCard
        week={data.week}
        heavyWeek={heavyWeek}
        onSummary={(summary) => set((d) => ({ ...d, week: { ...d.week, summary } }))}
      />
      <EventsCard weekStart={data.week.start || weekStartOf(today)} />
    </>
  )
}

function shiftMonth(view: { year: number; month: number }, delta: number) {
  const index = view.year * 12 + (view.month - 1) + delta
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

function addDays(date: string, days: number): [number, number, number] {
  const { year, month, day } = parseDate(date)
  const d = new Date(Date.UTC(year, month - 1, day + days))
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
}
