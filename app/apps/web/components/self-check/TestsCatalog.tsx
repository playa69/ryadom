'use client'

import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { allTests } from '@ryadom/self-check/catalog'
import { Card } from '@ryadom/ui/components/card'
import { BUTTON } from '../controls'
import SavedLine from './SavedLine'
import { useSelfCheck } from './useSelfCheck'

/** The segment «Тесты»: every test of the catalog with search over the title, the code and the description. */
export default function TestsCatalog() {
  const { start, openHistory, latest } = useSelfCheck()
  const [query, setQuery] = useState('')
  const found = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allTests
    return allTests.filter((t) => `${t.title} ${t.code} ${t.subtitle} ${t.preface}`.toLowerCase().includes(q))
  }, [query])

  return (
    <div className="flex flex-col gap-3" data-testid="tests-catalog">
      <p className="text-sm text-dim">Опросники, которыми пользуются специалисты. Это скрининг, а не диагноз.</p>
      <label className="flex items-center gap-2 rounded-full border border-line px-4 py-2">
        <Search aria-hidden className="size-4 text-dim" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по названию и коду"
          aria-label="Поиск по тестам"
          data-testid="tests-search"
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-dim"
        />
      </label>
      {found.length === 0 && (
        <p className="text-dim" data-testid="tests-empty">
          Ничего не нашлось. Попробуй другое слово.
        </p>
      )}
      {found.map((t) => (
        <Card key={t.id} className="gap-1 rounded-lg px-5 py-4 shadow-none" data-testid={`tests-card-${t.id}`}>
          <div className="font-semibold text-foreground">
            {t.title} <span className="text-sm font-normal text-dim">{t.code}</span>
          </div>
          <div className="text-sm text-dim">{t.preface}</div>
          <div className="mt-1 flex items-center justify-between">
            <span className="text-sm text-dim">
              <SavedLine test={t} result={latest[t.id]} />
            </span>
            <span className="flex items-center gap-4">
              {latest[t.id] && (
                <button type="button" className={`${BUTTON} text-sm font-semibold text-dim`} onClick={() => openHistory(t)} data-testid={`tests-history-${t.id}`}>
                  История
                </button>
              )}
              <button type="button" className={`${BUTTON} font-semibold text-brand-400`} onClick={() => start(t, 'tests')} data-testid={`tests-start-${t.id}`}>
                Пройти →
              </button>
            </span>
          </div>
        </Card>
      ))}
    </div>
  )
}
