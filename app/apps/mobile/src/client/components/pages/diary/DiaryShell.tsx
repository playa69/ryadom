import { Navbar, Page } from 'framework7-react'
import type { Router } from 'framework7/types'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { track } from '@ryadom/analytics/browser'
import { useEffect, type ReactNode } from 'react'
import { rememberSegment, SEGMENT_URLS, type DiarySegment } from '../../../lib/diary'
import { SosButton } from '../../SosSheet'

/**
 * The frame of the diary screens: the bar, SOS and the segments «Дневник · Журнал · Тесты».
 * Each segment is a route of its own (`/diary/…`), swapped in place so the tab keeps one entry in its
 * history; the last one opened is remembered on the device.
 */

const SEGMENTS: Array<{ id: DiarySegment; label: string }> = [
  { id: 'diary', label: 'Дневник' },
  { id: 'journal', label: 'Журнал' },
  { id: 'tests', label: 'Тесты' },
]

/** Set once the person has chosen a segment by hand: the stored one is for opening the tab, not for going back. */
export const segmentChosen = { value: false }

export default function DiaryShell({
  segment,
  f7router,
  onTabShow,
  children,
}: {
  segment: DiarySegment
  f7router: Router.Router
  onTabShow?: () => void
  children: ReactNode
}) {
  // Which segment was opened, once per opening of the page: never what is on it.
  useEffect(() => {
    // The journal has its own event (an entry opened); only the diary card counts as «diary opened».
    track(AnalyticsEvent.DiaryOpened, { tab: segment })
  }, [segment])

  function choose(next: DiarySegment) {
    if (next === segment) return
    segmentChosen.value = true
    // Only a choice is remembered: the screen opening on the stored segment must not overwrite it with «Дневник».
    rememberSegment(next)
    f7router.navigate(SEGMENT_URLS[next], { reloadCurrent: true, animate: false })
  }

  return (
    <Page
      name="diary"
      className={`rd-diary-page ph-no-capture${segment === 'journal' ? ' rd-journal-page' : ''}`}
      onPageTabShow={onTabShow}
    >
      <Navbar title="Дневник" />
      <SosButton slot="fixed" source="header" />
      <div className={segment === 'journal' ? 'rd-diary rd-diary--journal' : 'rd-diary'}>
        <div className="rd-segment rd-diary-segments" role="radiogroup" aria-label="Раздел дневника">
          {SEGMENTS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={item.id === segment}
              data-testid={`diary-segment-${item.id}`}
              onClick={() => choose(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {children}
      </div>
    </Page>
  )
}
