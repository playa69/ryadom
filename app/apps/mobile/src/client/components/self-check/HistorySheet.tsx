import { track } from '@ryadom/analytics/browser'
import { reportSelfCheckOpened } from '@ryadom/analytics/self-check'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import type { SelfCheckResultApi } from '@ryadom/contracts/api/self-check'
import { byId } from '@ryadom/self-check/catalog'
import {
  chartPoints,
  chartResults,
  formatDay,
  toneOfResult,
  versionsDiffer,
} from '@ryadom/self-check/history'
import type { SelfCheckTest } from '@ryadom/self-check/types'
import { Button, Sheet, f7 } from 'framework7-react'
import { useCallback, useEffect, useState } from 'react'
import { deleteSelfCheckResult, deleteSelfCheckResults, listSelfCheckResults } from '../../lib/api'
import { openTest } from '../../lib/self-check'
import { HISTORY_EVENT, notify, refreshLatestResults } from '../../lib/self-check-store'
import { TONE_COLOR, lengthLine } from './format'

const CHART_W = 320
const CHART_H = 110

/** The screen of one test: the history (newest on top), the chart from the second result and the deletion of one result or of the test's results. */
export default function HistorySheet() {
  const [test, setTest] = useState<SelfCheckTest | null>(null)
  const [opened, setOpened] = useState(false)
  const [items, setItems] = useState<SelfCheckResultApi[] | null>(null)

  const load = useCallback((t: SelfCheckTest) => {
    listSelfCheckResults(t.id)
      .then((r) => setItems(r.items))
      .catch(() => {
        setItems([])
        notify('Не получилось загрузить историю.', 'error')
      })
  }, [])

  useEffect(() => {
    function handler(event: Event) {
      const next = byId((event as CustomEvent<{ testId: string }>).detail.testId)
      if (!next) return
      setTest(next)
      setItems(null)
      setOpened(true)
      reportSelfCheckOpened('history')
      track(AnalyticsEvent.SelfCheckHistoryOpened, { test_id: next.id })
      load(next)
    }
    window.addEventListener(HISTORY_EVENT, handler)
    return () => window.removeEventListener(HISTORY_EVENT, handler)
  }, [load])

  function removeOne(r: SelfCheckResultApi) {
    if (!test) return
    f7.dialog.confirm(
      `Результат от ${formatDay(r.takenAt)} (${r.score}/${test.scoring.max}) исчезнет с сервера. Вернуть его нельзя.`,
      'Удалить результат?',
      () => {
        deleteSelfCheckResult(r.id)
          .then(() => {
            notify('Результат удалён.', 'success')
            refreshLatestResults()
            load(test)
          })
          .catch(() => notify('Не получилось удалить. Повтори ещё раз.', 'error'))
      },
    )
  }

  function removeAll() {
    if (!test) return
    f7.dialog.confirm(
      `Результаты теста «${test.title}», история и график исчезнут с сервера. Вернуть их нельзя.`,
      'Удалить все результаты теста?',
      () => {
        deleteSelfCheckResults(test.id)
          .then(() => {
            notify('Результаты теста удалены.', 'success')
            refreshLatestResults()
            setOpened(false)
          })
          .catch(() => notify('Не получилось удалить. Повтори ещё раз.', 'error'))
      },
    )
  }

  const points = test && items ? chartPoints(test, items, CHART_W, CHART_H) : []

  return (
    <Sheet
      className="ph-no-capture rd-test-sheet"
      opened={opened}
      onSheetClosed={() => setOpened(false)}
      swipeToClose
      closeOnEscape
      backdrop
      style={{ height: 'auto' }}
    >
      {test && (
        <div className="rd-sheet-body rd-sheet-body--scroll" data-testid="test-history">
          <div className="rd-test-head">
            <div>
              <h2 className="rd-sheet-title">{test.title}</h2>
              <span className="rd-muted">{lengthLine(test)}</span>
            </div>
            <button
              type="button"
              className="rd-test-close"
              aria-label="Закрыть"
              data-testid="history-close"
              onClick={() => setOpened(false)}
            >
              ×
            </button>
          </div>
          {items === null && <p className="rd-muted">Загружаю…</p>}
          {items && items.length === 0 && (
            <p className="rd-muted" data-testid="history-empty">
              Сохранённых результатов нет.
            </p>
          )}
          {items && items.length > 0 && (
            <div className="rd-card" data-testid="history-chart-card">
              <h3 className="rd-card-title">Динамика</h3>
              {chartResults(items) ? (
                <>
                  <svg
                    viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                    role="img"
                    aria-label="График баллов по датам"
                    className="rd-test-chart"
                    data-testid="history-chart"
                  >
                    <polyline
                      fill="none"
                      stroke="#4da3ff"
                      strokeWidth="2.5"
                      points={points.map((p) => `${p.x},${p.y}`).join(' ')}
                    />
                    {points.map((p) => (
                      <circle
                        key={p.result.id}
                        cx={p.x}
                        cy={p.y}
                        r="5"
                        fill={TONE_COLOR[toneOfResult(test, p.result)]}
                        data-testid="history-chart-point"
                      />
                    ))}
                  </svg>
                  <p className="rd-muted rd-test-note">
                    Смотри на направление, а не на отдельное число: что означает балл, написано в подписи
                    уровня.
                    {versionsDiffer(items) ? ' Формулировки теста менялись: сравнение приблизительное.' : ''}
                  </p>
                </>
              ) : (
                <p className="rd-muted" data-testid="history-chart-empty">
                  График появится после второго результата.
                </p>
              )}
            </div>
          )}
          {items && items.length > 0 && (
            <ul className="rd-test-list" data-testid="history-list">
              {items.map((r) => (
                <li key={r.id} className="rd-test-row" data-testid="history-row">
                  <i
                    aria-hidden="true"
                    className="rd-dot"
                    style={{ background: TONE_COLOR[toneOfResult(test, r)] }}
                  />
                  <span className="rd-test-row-text">
                    <b>
                      {formatDay(r.takenAt)}: {r.score}/{test.scoring.max}
                    </b>
                    <span className="rd-muted">{r.band}</span>
                  </span>
                  <button
                    type="button"
                    className="rd-link-button rd-link-button--dim"
                    aria-label="Удалить результат"
                    data-testid="history-delete"
                    onClick={() => removeOne(r)}
                  >
                    🗑
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button
            large
            fill
            data-testid="history-retake"
            onClick={() => {
              track(AnalyticsEvent.SelfCheckResultAction, { test_id: test.id, action: 'retake' })
              setOpened(false)
              openTest(test.id, 'history')
            }}
          >
            Пройти снова
          </Button>
          {items && items.length > 0 && (
            <button
              type="button"
              className="rd-link-button rd-link-button--dim"
              data-testid="history-delete-test"
              onClick={removeAll}
            >
              Удалить все результаты этого теста
            </button>
          )}
        </div>
      )}
    </Sheet>
  )
}
