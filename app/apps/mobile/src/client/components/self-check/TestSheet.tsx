import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Button, Sheet, f7 } from 'framework7-react'
import { useEffect, useState } from 'react'
import { byId } from '@ryadom/self-check/catalog'
import {
  answerPass,
  backPass,
  closePass,
  progressThird,
  resumePass,
  showResult,
  startPass,
  type PassState,
} from '@ryadom/self-check/pass'
import { band as bandOf, isHigh, retakeAfterDays, score as scoreOf } from '@ryadom/self-check/score'
import type { SelfCheckTest } from '@ryadom/self-check/types'
import { startTalk } from '../../lib/nav'
import { TEST_EVENT, type SelfCheckFrom } from '../../lib/self-check'
import { openSos } from '../SosSheet'
import { DISCLAIMER, TONE_COLOR, lengthLine, plural } from './format'

/**
 * One pass of one test in a sheet (add-self-check-tests): a question at a time, a tap answers and moves on, «Назад»
 * keeps the answer, «×» after three answers asks first. A crisis answer opens the help screen after the last
 * question, before the result, and it has no way out but its three buttons. Nothing leaves the device here.
 */
export default function TestSheet() {
  const [test, setTest] = useState<SelfCheckTest | null>(null)
  const [pass, setPass] = useState<PassState | null>(null)
  const [opened, setOpened] = useState(false)

  useEffect(() => {
    function handler(event: Event) {
      const { testId, from } = (event as CustomEvent<{ testId: string; from: SelfCheckFrom }>).detail
      const next = byId(testId)
      if (!next) return
      setTest(next)
      setPass(startPass(next))
      setOpened(true)
      track(AnalyticsEvent.SelfCheckStarted, { test_id: next.id, from })
    }
    window.addEventListener(TEST_EVENT, handler)
    return () => window.removeEventListener(TEST_EVENT, handler)
  }, [])

  function close() {
    setOpened(false)
  }

  function requestClose() {
    if (!test || !pass) return close()
    const next = closePass(test, pass)
    if (next.closed) close()
    else setPass(next.state)
  }

  function answer(value: number) {
    if (!test || !pass) return
    const next = answerPass(test, pass, value)
    if (next.phase !== 'question') track(AnalyticsEvent.SelfCheckCompleted, { test_id: test.id })
    setPass(next)
  }

  return (
    <Sheet
      className="ph-no-capture rd-test-sheet"
      opened={opened}
      onSheetClosed={() => setOpened(false)}
      closeByBackdropClick={false}
      closeOnEscape={false}
      swipeToClose={false}
      backdrop
      style={{ height: 'auto' }}
    >
      {test && pass && (
        <div className="rd-sheet-body rd-sheet-body--scroll" data-testid="test-sheet">
          <div className="rd-test-head">
            <div>
              <h2 className="rd-sheet-title" data-testid="test-title">
                {test.title}
              </h2>
              <span className="rd-muted" data-testid="test-subtitle">
                {lengthLine(test)}
              </span>
            </div>
            {pass.phase !== 'crisis' && (
              <button type="button" className="rd-test-close" aria-label="Закрыть" data-testid="test-close" onClick={requestClose}>
                ×
              </button>
            )}
          </div>

          {pass.phase === 'question' && (
            <div className="rd-test-body" data-testid="test-question">
              <div className="rd-test-progress-label" data-testid="test-progress-label">
                Вопрос {pass.step + 1} из {test.items.length}
              </div>
              <div role="progressbar" aria-valuemin={0} aria-valuemax={test.items.length} aria-valuenow={pass.step} className="rd-test-progress">
                <i style={{ width: `${(pass.step / test.items.length) * 100}%` }} />
              </div>
              <p className="rd-muted">{test.preface}</p>
              <h3 className="rd-test-item" data-testid="test-item">
                {test.items[pass.step]?.text}
              </h3>
              <div className="rd-test-options">
                {test.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className="rd-test-option"
                    data-testid={`test-option-${o.value}`}
                    aria-pressed={pass.answers[pass.step] === o.value}
                    onClick={() => answer(o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {pass.step > 0 && (
                <button
                  type="button"
                  className="rd-link-button"
                  data-testid="test-back"
                  onClick={() => {
                    track(AnalyticsEvent.SelfCheckStepBack, { test_id: test.id })
                    setPass(backPass(pass))
                  }}
                >
                  ← Назад
                </button>
              )}
              <p className="rd-muted rd-test-note">Ответы остаются на устройстве, пока ты не нажмёшь «Сохранить».</p>
            </div>
          )}

          {pass.phase === 'interrupt' && (
            <div className="rd-test-body rd-test-center" data-testid="test-interrupt">
              <h3 className="rd-sheet-title">Прервать тест?</h3>
              <p className="rd-muted">Ответы не сохранятся.</p>
              <Button
                large
                fill
                data-testid="test-continue"
                onClick={() => {
                  track(AnalyticsEvent.SelfCheckInterruptChoice, { test_id: test.id, action: 'continue', progress: progressThird(test, pass) })
                  setPass(resumePass(pass))
                }}
              >
                Продолжить тест
              </Button>
              <Button
                large
                outline
                data-testid="test-abort"
                onClick={() => {
                  track(AnalyticsEvent.SelfCheckInterruptChoice, { test_id: test.id, action: 'abort', progress: progressThird(test, pass) })
                  close()
                }}
              >
                Прервать
              </Button>
            </div>
          )}

          {pass.phase === 'crisis' && (
            <div className="rd-test-body rd-test-center" data-testid="test-crisis" role="alertdialog" aria-label="Помощь">
              <h3 className="rd-sheet-title">Ты отметил(а), что бывают мысли о смерти или о том, чтобы навредить себе</h3>
              <p className="rd-muted">С этим не нужно справляться одному. Если тяжело прямо сейчас — позвони, это бесплатно и анонимно.</p>
              {/* No event for any of these: a crisis answer is never reported and never tied to a person. */}
              <Button large outline className="rd-danger" data-testid="crisis-call" onClick={() => openSos()}>
                Позвонить
              </Button>
              <Button
                large
                fill
                data-testid="crisis-talk"
                onClick={() => {
                  close()
                  startTalk()
                }}
              >
                Поговорить с Рядом
              </Button>
              <Button large outline data-testid="crisis-result" onClick={() => setPass(showResult(pass))}>
                Посмотреть результат
              </Button>
              <p className="rd-muted rd-test-note">Этот ответ не сохраняется и не передаётся.</p>
            </div>
          )}

          {pass.phase === 'result' && <Result test={test} answers={pass.answers as number[]} onClose={close} />}
        </div>
      )}
    </Sheet>
  )
}

function Result({ test, answers, onClose }: { test: SelfCheckTest; answers: number[]; onClose(): void }) {
  const result = scoreOf(test, answers)
  const level = bandOf(test, result.score)
  const high = isHigh(test, result.score)
  const weeks = retakeAfterDays(test, result.score) / 7
  const index = level ? test.bands.indexOf(level) : -1
  const [copied, setCopied] = useState(false)

  async function copy() {
    track(AnalyticsEvent.SelfCheckResultAction, { test_id: test.id, action: 'copy_summary' })
    const date = new Date().toLocaleDateString('ru-RU')
    const line = `${test.title} (${test.code}), ${date}: ${result.score} из ${result.max}${level ? ` — ${level.label}` : ''}`
    try {
      await navigator.clipboard.writeText(line)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="rd-test-body" data-testid="test-result">
      <h3 className="rd-sheet-title">Результат</h3>
      <div className="rd-test-score" data-testid="result-score">
        {result.score} <span className="rd-muted">/ {result.max}</span>
      </div>
      {result.subscales.length > 0 && (
        <ul className="rd-muted">
          {result.subscales.map((s) => (
            <li key={s.id}>
              {s.label}: {s.score}
            </li>
          ))}
        </ul>
      )}
      {level && (
        <span className="rd-test-level" style={{ background: `${TONE_COLOR[level.tone]}33`, color: TONE_COLOR[level.tone] }} data-testid="result-level">
          {level.label}
        </span>
      )}
      <div className="rd-test-scale" aria-hidden="true">
        {test.bands.map((b, i) => (
          <i key={b.from} style={{ background: TONE_COLOR[b.tone], opacity: i === index ? 1 : 0.35 }} />
        ))}
      </div>
      {level && <p className="rd-muted">{level.text}</p>}
      {high && (
        <button
          type="button"
          className="rd-test-specialist"
          data-testid="result-specialist"
          onClick={() => {
            onClose()
            f7.views.main.router.navigate('/people/')
          }}
        >
          <b>Поговорить со специалистом</b>
          <span className="rd-muted">Подберём человека в разделе «Люди рядом»</span>
        </button>
      )}
      <p className="rd-muted" data-testid="result-retake">
        Повтори тест через {weeks} {plural(weeks, ['неделю', 'недели', 'недель'])} — так видно динамику.
      </p>
      <p className="rd-muted rd-test-note">{DISCLAIMER}</p>
      <Button
        large
        outline
        data-testid="result-close"
        onClick={() => {
          track(AnalyticsEvent.SelfCheckResultAction, { test_id: test.id, action: 'close' })
          onClose()
        }}
      >
        Закрыть
      </Button>
      <button type="button" className="rd-link-button" data-testid="result-copy" onClick={copy}>
        {copied ? 'Скопировано' : 'Скопировать итог для специалиста'}
      </button>
    </div>
  )
}
