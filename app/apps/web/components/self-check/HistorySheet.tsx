'use client'

import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import type { SelfCheckResultApi } from '@ryadom/contracts/api/self-check'
import {
  chartPoints,
  chartResults,
  formatDay,
  toneOfResult,
  versionsDiffer,
} from '@ryadom/self-check/history'
import type { SelfCheckTest } from '@ryadom/self-check/types'
import { Button } from '@ryadom/ui/components/button'
import { useClient } from '@/lib/auth'
import { BUTTON } from '../controls'
import Modal from '../Modal'
import { useNotice } from '../Notice'
import { TONE_COLOR, lengthLine } from './ui'
import { useSelfCheck } from './useSelfCheck'

type Confirm = { kind: 'one'; result: SelfCheckResultApi } | { kind: 'test' } | null

const CHART_W = 320
const CHART_H = 110

/** The screen of one test: the history (newest on top), the chart from the second result and the deletion of one result or of the test's results. */
export default function HistorySheet({ test, onClose }: { test: SelfCheckTest; onClose(): void }) {
  const client = useClient()
  const notify = useNotice()
  const { start, refresh } = useSelfCheck()
  const [items, setItems] = useState<SelfCheckResultApi[] | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    client
      .listSelfCheckResults(test.id)
      .then((r) => setItems(r.items))
      .catch(() => {
        setItems([])
        notify('Не получилось загрузить историю.', 'error')
      })
  }, [client, notify, test.id])

  useEffect(() => {
    track(AnalyticsEvent.SelfCheckHistoryOpened, { test_id: test.id })
    load()
  }, [load, test.id])

  async function remove() {
    if (!confirm) return
    setBusy(true)
    try {
      if (confirm.kind === 'one') await client.deleteSelfCheckResult(confirm.result.id)
      else await client.deleteSelfCheckResults(test.id)
      notify(confirm.kind === 'one' ? 'Результат удалён.' : 'Результаты теста удалены.', 'success')
      setConfirm(null)
      refresh()
      if (confirm.kind === 'test') onClose()
      else load()
    } catch {
      notify('Не получилось удалить. Повтори ещё раз.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const points = items ? chartPoints(test, items, CHART_W, CHART_H) : []
  const shown = items ?? []

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={test.title}
        dismissible
        className="max-h-[calc(100dvh-1rem)] overflow-y-auto"
      >
        <div className="flex flex-col gap-3" data-testid="test-history">
          <div className="text-sm text-dim">{lengthLine(test)}</div>
          {items === null && <p className="text-dim">Загружаю…</p>}
          {items && items.length === 0 && (
            <p className="text-dim" data-testid="history-empty">
              Сохранённых результатов нет.
            </p>
          )}
          {items && items.length > 0 && (
            <div className="rounded-lg border border-line p-3" data-testid="history-chart-card">
              <div className="mb-1 font-semibold">Динамика</div>
              {chartResults(items) ? (
                <>
                  <svg
                    viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                    role="img"
                    aria-label="График баллов по датам"
                    className="w-full"
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
                  <p className="text-xs text-faint">
                    Смотри на направление, а не на отдельное число: что означает балл, написано в подписи
                    уровня.
                    {versionsDiffer(items) ? ' Формулировки теста менялись: сравнение приблизительное.' : ''}
                  </p>
                </>
              ) : (
                <p className="text-sm text-dim" data-testid="history-chart-empty">
                  График появится после второго результата.
                </p>
              )}
            </div>
          )}
          {shown.length > 0 && (
            <ul className="divide-y divide-line" data-testid="history-list">
              {shown.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2" data-testid="history-row">
                  <i
                    aria-hidden="true"
                    className="size-2.5 rounded-full"
                    style={{ background: TONE_COLOR[toneOfResult(test, r)] }}
                  />
                  <span className="flex-1">{formatDay(r.takenAt)}</span>
                  <b>
                    {r.score}/{test.scoring.max}
                  </b>
                  <span className="text-sm text-dim">{r.band}</span>
                  <button
                    type="button"
                    aria-label="Удалить результат"
                    className={`${BUTTON} p-1 text-dim`}
                    data-testid="history-delete"
                    onClick={() => setConfirm({ kind: 'one', result: r })}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button
            className={BUTTON}
            data-testid="history-retake"
            onClick={() => {
              track(AnalyticsEvent.SelfCheckResultAction, { test_id: test.id, action: 'retake' })
              onClose()
              start(test, 'history')
            }}
          >
            Пройти снова
          </Button>
          {shown.length > 0 && (
            <button
              type="button"
              className={`${BUTTON} text-sm text-dim`}
              data-testid="history-delete-test"
              onClick={() => setConfirm({ kind: 'test' })}
            >
              Удалить все результаты этого теста
            </button>
          )}
        </div>
      </Modal>
      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(null)}
          title={
            confirm.kind === 'one' ? 'Удалить результат?' : `Удалить все результаты теста «${test.title}»?`
          }
          dismissible
        >
          <div className="flex flex-col gap-3 text-center" data-testid="history-confirm">
            <p className="text-dim">
              {confirm.kind === 'one'
                ? `Результат от ${formatDay(confirm.result.takenAt)} (${confirm.result.score}/${test.scoring.max}) исчезнет с сервера. Вернуть его нельзя.`
                : `Результаты теста «${test.title}», история и график исчезнут с сервера. Вернуть их нельзя.`}
            </p>
            <Button
              variant="outline"
              className={`${BUTTON} border-sos text-sos`}
              disabled={busy}
              data-testid="history-confirm-yes"
              onClick={() => void remove()}
            >
              Удалить
            </Button>
            <Button
              variant="outline"
              className={BUTTON}
              data-testid="history-confirm-no"
              onClick={() => setConfirm(null)}
            >
              Отмена
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}
