'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { track } from '@ryadom/analytics/browser'
import { Suspense, useEffect } from 'react'
import { cn } from '@ryadom/ui/lib/utils'
import { DIARY_SEGMENTS, segmentHref, writeLastSegment, type DiarySegment } from '@/lib/diary'
import { FOCUS_RING } from '../controls'
import { Page } from '../Page'
import JournalScreen from '../JournalScreen'
import DiaryHome from './DiaryHome'
import TestsCatalog from '../self-check/TestsCatalog'
import { SelfCheckProvider } from '../self-check/useSelfCheck'

/**
 * The «Дневник» section: the segments «Дневник · Журнал» under the header and the content
 * of the open one. The last open segment is remembered on the device.
 */
export default function DiaryScreen({ segment }: { segment: DiarySegment }) {
  const router = useRouter()
  // The address of a segment that has nothing to show (no test is ready) leads back to the diary, as if it did not exist.
  const missing = !DIARY_SEGMENTS.some((s) => s.key === segment)
  useEffect(() => {
    if (missing) {
      router.replace('/diary')
      return
    }
    writeLastSegment(segment)
    // Which segment was opened, once per opening: never what is on it.
    track(AnalyticsEvent.DiaryOpened, { tab: segment })
  }, [segment, missing, router])

  if (missing) return null

  return (
    <SelfCheckProvider>
    <Page
      title="Дневник"
      measure={segment === 'journal' ? 'reading' : 'form'}
      className={cn('gap-5', segment === 'diary' && 'max-w-150')}
      data-testid="diary-page"
    >
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
      {segment === 'journal' && <JournalScreen />}
      {segment === 'tests' && <TestsCatalog />}
    </Page>
    </SelfCheckProvider>
  )
}
