import { Button } from 'framework7-react'
import { openTest, shownWave1 } from '../../../lib/self-check'
import { refreshLatestResults, openHistory, useLatestResults } from '../../../lib/self-check-store'
import SavedLine from '../../self-check/SavedLine'
import { useEffect } from 'react'

/** The block «Самопроверка» in the segment «Дневник»: the six scales of wave 1. Absent with the tests off. */
export default function SelfCheckBlock() {
  const tests = shownWave1()
  const latest = useLatestResults()
  useEffect(() => refreshLatestResults(), [])
  if (tests.length === 0) return null
  return (
    <section className="rd-card rd-self-check" data-testid="self-check-block" aria-labelledby="self-check-title">
      <h2 className="rd-card-title" id="self-check-title">
        Самопроверка
      </h2>
      <p className="rd-muted">Научные скрининговые опросники. Это не диагноз — только ориентир.</p>
      <ul className="rd-test-list">
        {tests.map((t) => (
          <li key={t.id} className="rd-test-row" data-testid={`self-check-row-${t.id}`}>
            <div className="rd-test-row-text">
              <b>{t.title}</b>
              <span className="rd-muted">
                <SavedLine test={t} result={latest[t.id]} />
              </span>
            </div>
            {latest[t.id] && (
              <button type="button" className="rd-link-button" data-testid={`self-check-history-${t.id}`} onClick={() => openHistory(t.id)}>
                История
              </button>
            )}
            <Button small outline data-testid={`self-check-start-${t.id}`} onClick={() => openTest(t.id, 'diary')}>
              Пройти
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
