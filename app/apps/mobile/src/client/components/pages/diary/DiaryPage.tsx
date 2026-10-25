import { Block, Preloader } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useEffect, useState } from 'react'
import { currentWeekStart, diary, rememberedSegment, SEGMENT_URLS, useDiary } from '../../../lib/diary'
import { deviceDate } from '../../../lib/diary-queue'
import DiaryShell, { segmentChosen } from './DiaryShell'
import EventsCard from './EventsCard'
import MoodCard from './MoodCard'
import MoodChart from './MoodChart'
import PreviousWeekCard from './PreviousWeekCard'
import WeekCard from './WeekCard'

/** Opened once per launch: the stored segment is where the tab opens, not a trap for «Дневник». */
const restore = { done: false }

/**
 * Segment «Дневник»: the mood card, the 28-day chart, the week summary, the self-check (PROTEUS-218) and
 * the events of the week, top to bottom.
 */
export default function DiaryPage({ f7router }: { f7router: Router.Router }) {
  const { data, error } = useDiary()
  // The events block asks again whenever the tab is shown: memory may have been switched in the profile meanwhile.
  const [shown, setShown] = useState(0)

  useEffect(() => {
    void diary.refresh()
    if (restore.done || segmentChosen.value) return
    restore.done = true
    // An address with intent (the shortcut) is the card; only a plain opening restores.
    if (f7router.currentRoute.query?.checkin) return
    void rememberedSegment().then((segment) => {
      if (segment !== 'diary') f7router.navigate(SEGMENT_URLS[segment], { reloadCurrent: true, animate: false })
    })
  }, [f7router])

  return (
    <DiaryShell segment="diary" f7router={f7router} onTabShow={() => {
        void diary.refresh()
        setShown((n) => n + 1)
      }}>
      {data === null && !error && (
        <Block className="text-align-center">
          <Preloader />
        </Block>
      )}
      {error && !data && (
        <p className="rd-form-error" data-testid="form-error">
          {error}
        </p>
      )}
      {data && (
        <>
          <MoodCard data={data} f7router={f7router} />
          <MoodChart data={data} today={deviceDate()} />
          <WeekCard data={data} f7router={f7router} />
          {data.previousWeek && <PreviousWeekCard summary={data.previousWeek} f7router={f7router} />}
          <section className="rd-card" data-testid="diary-selfcheck" aria-labelledby="diary-selfcheck-title">
            <h2 className="rd-card-title" id="diary-selfcheck-title">
              Самопроверка
            </h2>
            <p className="rd-muted">Скоро: короткие вопросы, чтобы лучше понять, как ты</p>
          </section>
          <EventsCard key={shown} week={currentWeekStart()} />
        </>
      )}
    </DiaryShell>
  )
}
