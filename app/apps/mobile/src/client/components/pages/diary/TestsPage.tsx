import { useSelfCheckOpened, useSelfCheckSearchReport } from '@ryadom/analytics/react'
import type { Router } from 'framework7/types'
import { useEffect, useMemo, useState } from 'react'
import { openTest, shownTests } from '../../../lib/self-check'
import { refreshLatestResults, openHistory, useLatestResults } from '../../../lib/self-check-store'
import SavedLine from '../../self-check/SavedLine'
import DiaryShell from './DiaryShell'

/** Segment «Тесты»: every shown test with search over the title, the code and the description. */
export default function TestsPage({ f7router }: { f7router: Router.Router }) {
  const [query, setQuery] = useState('')
  const latest = useLatestResults()
  useEffect(() => refreshLatestResults(), [])
  const all = useMemo(() => shownTests(), [])
  const found = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? all.filter((t) => `${t.title} ${t.code} ${t.subtitle} ${t.preface}`.toLowerCase().includes(q)) : all
  }, [all, query])
  useSelfCheckOpened('tests')
  useSelfCheckSearchReport(query, found.length > 0)

  return (
    <DiaryShell segment="tests" f7router={f7router}>
      <div className="rd-tests" data-testid="tests-catalog">
        <p className="rd-muted">Опросники, которыми пользуются специалисты. Это скрининг, а не диагноз.</p>
        <input
          type="search"
          className="rd-test-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по названию и коду"
          aria-label="Поиск по тестам"
          data-testid="tests-search"
        />
        {found.length === 0 && (
          <p className="rd-muted" data-testid="tests-empty">
            Ничего не нашлось. Попробуй другое слово.
          </p>
        )}
        {found.map((t) => (
          <section key={t.id} className="rd-card" data-testid={`tests-card-${t.id}`}>
            <h2 className="rd-card-title">
              {t.title} <span className="rd-muted">{t.code}</span>
            </h2>
            <p className="rd-muted">{t.preface}</p>
            <div className="rd-test-card-foot">
              <span className="rd-muted">
                <SavedLine test={t} result={latest[t.id]} />
              </span>
              <span className="rd-test-card-actions">
                {latest[t.id] && (
                  <button type="button" className="rd-link-button rd-link-button--dim" data-testid={`tests-history-${t.id}`} onClick={() => openHistory(t.id)}>
                    История
                  </button>
                )}
                <button type="button" className="rd-link-button" data-testid={`tests-start-${t.id}`} onClick={() => openTest(t.id, 'tests')}>
                  Пройти →
                </button>
              </span>
            </div>
          </section>
        ))}
      </div>
    </DiaryShell>
  )
}
