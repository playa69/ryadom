import { Button, Preloader } from 'framework7-react'
import { useEffect, useState } from 'react'
import { longDate } from '@ryadom/client-core/diary'
import type { DiaryEventsApiResponse } from '@ryadom/contracts/api/diary'
import { loadDiaryEvents } from '../../../lib/diary'
import { openRoute } from '../../../lib/nav'

/**
 * «События этой недели»: short notes from the agent's memory, by day. Memory off and no notes have words of
 * their own. The notes are the person's: shown here, kept nowhere.
 */
export default function EventsCard({ week }: { week: string }) {
  const [events, setEvents] = useState<DiaryEventsApiResponse | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    loadDiaryEvents(week)
      .then((result) => !cancelled && setEvents(result))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [week])

  const days = new Map<string, string[]>()
  for (const item of events?.items ?? []) days.set(item.date, [...(days.get(item.date) ?? []), item.text])

  return (
    <section className="rd-card rd-events-card" data-testid="diary-events-card" aria-labelledby="diary-events-title">
      <h2 className="rd-card-title" id="diary-events-title">
        События этой недели
      </h2>
      {events === null && !failed && <Preloader size={20} />}
      {failed && <p className="rd-muted">Не получилось загрузить события</p>}
      {events && !events.memoryEnabled && (
        <div data-testid="diary-events-off">
          <p className="rd-muted">Память выключена — события не собираются</p>
          <Button small round outline onClick={() => openRoute('/profile/memory/')}>
            Раздел «Память»
          </Button>
        </div>
      )}
      {events?.memoryEnabled && days.size === 0 && (
        <p className="rd-muted" data-testid="diary-events-empty">
          Пока пусто. Разговаривай с Рядом — он начнёт запоминать важное, и здесь появится история
        </p>
      )}
      {[...days.entries()].map(([date, texts]) => (
        <div key={date} className="rd-events-day">
          <p className="rd-caption">{longDate(date)}</p>
          <ul>
            {texts.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
