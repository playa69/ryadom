'use client'

import Link from 'next/link'
import { Suspense, useEffect } from 'react'
import { Card } from '@ryadom/ui/components/card'
import { cn } from '@ryadom/ui/lib/utils'
import { DIARY_SEGMENTS, segmentHref, writeLastSegment, type DiarySegment } from '@/lib/diary'
import { FOCUS_RING } from '../controls'
import { Page } from '../Page'
import DiaryHome from './DiaryHome'
import YearView from './YearView'

/**
 * The «Дневник» section: the segments «Дневник · Итоги · Год» under the header and the content
 * of the open one. The last open segment is remembered on the device.
 */
export default function DiaryScreen({ segment }: { segment: DiarySegment }) {
  useEffect(() => {
    writeLastSegment(segment)
  }, [segment])

  return (
    <Page title="Дневник" measure="form" className="gap-5 max-w-150" data-testid="diary-page">
      <nav aria-label="Разделы дневника" className="flex gap-1 rounded-full border border-line p-1" data-testid="diary-segments">
        {DIARY_SEGMENTS.map((s) => (
          <Link
            key={s.key}
            href={segmentHref(s.key)}
            aria-current={s.key === segment ? 'page' : undefined}
            data-testid={`diary-segment-${s.key}`}
            className={cn(
              FOCUS_RING,
              'min-h-10 flex-1 rounded-full px-3 py-2 text-center text-sm font-semibold text-dim transition-colors hover:text-foreground',
              s.key === segment && 'bg-white/10 text-foreground',
            )}
          >
            {s.label}
          </Link>
        ))}
      </nav>

      {segment === 'diary' && (
        <Suspense>
          <DiaryHome />
        </Suspense>
      )}
      {segment === 'year' && <YearView />}
      {segment === 'recaps' && (
        <Card className="rounded-lg px-5 py-6 shadow-none" data-testid="diary-recaps-empty">
          <p className="text-[0.9375rem] leading-[1.55] text-dim">
            Здесь будут итоги ваших разговоров: о чём говорили, что стало главным и о чём договорились. Итог появляется сам, когда
            разговор закончился
          </p>
        </Card>
      )}
    </Page>
  )
}
