'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import { longDate } from '@ryadom/client-core/diary'
import type { DiaryEventsApiResponse } from '@ryadom/contracts/api/diary'
import { Card } from '@ryadom/ui/components/card'
import { Skeleton } from '@ryadom/ui/components/skeleton'
import { useClient } from '@/lib/auth'
import { useLoaded } from '@/lib/diary'

/** "События этой недели": short notes of the agent's memory by day. Empty and "memory off" are states of their own. */
export default function EventsCard({ weekStart }: { weekStart: string }) {
  const client = useClient()
  const { state } = useLoaded(() => client.getDiaryEvents(weekStart), weekStart)
  const groups = useMemo(() => {
    if (state.status !== 'ready') return []
    const byDate = new Map<string, string[]>()
    for (const item of state.data.items) byDate.set(item.date, [...(byDate.get(item.date) ?? []), item.text])
    return [...byDate.entries()].sort(([a], [b]) => (a < b ? 1 : -1))
  }, [state])

  return (
    <section className="flex flex-col gap-3" aria-labelledby="diary-events-title">
      <h2 id="diary-events-title" className="px-1 text-lg font-semibold text-foreground">
        События этой недели
      </h2>
      <Card className="gap-3 rounded-lg px-5 py-5 shadow-none" data-testid="diary-events-card">
        {state.status === 'loading' && <Skeleton className="h-12 w-full" />}
        {state.status === 'error' && (
          <p className="text-[0.9375rem] text-dim">Не получилось загрузить события</p>
        )}
        {state.status === 'ready' && !state.data.memoryEnabled && (
          <p className="text-[0.9375rem] leading-snug text-dim" data-testid="diary-events-off">
            Память выключена — события не собираются.{' '}
            <Link href="/profile/memory" className="text-brand-400 underline underline-offset-2">
              Память
            </Link>
          </p>
        )}
        {state.status === 'ready' && state.data.memoryEnabled && groups.length === 0 && (
          <p className="text-[0.9375rem] leading-snug text-dim" data-testid="diary-events-empty">
            Пока пусто. Разговаривай с Рядом — он начнёт запоминать важное, и здесь появится история
          </p>
        )}
        {groups.map(([date, texts]) => (
          <div key={date} className="flex flex-col gap-1">
            <p className="text-[0.8125rem] font-semibold text-faint">{longDate(date)}</p>
            {texts.map((text, i) => (
              <p key={i} className="text-[0.9375rem] leading-snug text-foreground">
                {text}
              </p>
            ))}
          </div>
        ))}
      </Card>
    </section>
  )
}
