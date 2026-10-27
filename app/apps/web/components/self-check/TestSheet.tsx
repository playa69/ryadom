'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { SelfCheckApiErrorCode, SELF_CHECK_CONSENT_VERSION } from '@ryadom/contracts/api/self-check'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent, type SelfCheckFrom, type SelfCheckProgress } from '@ryadom/analytics/events'
import { band as bandOf, hasCrisisAnswer, isHigh, retakeAfterDays, score as scoreOf } from '@ryadom/self-check/score'
import type { SelfCheckTest } from '@ryadom/self-check/types'
import { Button } from '@ryadom/ui/components/button'
import { useClient } from '@/lib/auth'
import { BUTTON } from '../controls'
import Modal from '../Modal'
import { useNotice } from '../Notice'
import { useSos } from '../Sos'
import { DISCLAIMER, TONE_COLOR, lengthLine, plural } from './ui'
import { useSelfCheck } from './useSelfCheck'

/** Answers before «×» asks whether to stop: a couple of taps are not worth a question. */
const INTERRUPT_FROM = 3

type Phase = 'question' | 'interrupt' | 'crisis' | 'result'

function progressOf(step: number, total: number): SelfCheckProgress {
  const third = total / 3
  return step < third ? 'first_third' : step < 2 * third ? 'second_third' : 'last_third'
}

/**
 * One pass of one test in a sheet: a question at a time, a tap answers and moves on, «Назад» keeps the
 * answer. Nothing leaves the device here: the answers live in this component until the sheet closes.
 */
export default function TestSheet({ test, from, onClose }: { test: SelfCheckTest; from: SelfCheckFrom; onClose(): void }) {
  const router = useRouter()
  const client = useClient()
  const { openSos } = useSos()
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<(number | null)[]>(() => test.items.map(() => null))
  const [phase, setPhase] = useState<Phase>('question')
  const total = test.items.length

  // A first question is shown: the start of a pass (once per mount, the sheet is keyed by the test).
  useState(() => {
    track(AnalyticsEvent.SelfCheckStarted, { test_id: test.id, from })
    return null
  })

  const answered = answers.filter((a) => a !== null).length
  const complete = answered === total

  function answer(value: number) {
    const next = answers.slice()
    next[step] = value
    setAnswers(next)
    if (step < total - 1) {
      setStep(step + 1)
      return
    }
    track(AnalyticsEvent.SelfCheckCompleted, { test_id: test.id })
    // After the last question and before the result: the help screen comes first whenever a crisis item fired,
    // whatever the score ends up as and whether or not there is a network. No event is sent for it.
    if (hasCrisisAnswer(test, next as number[])) {
      // The server's counter only (no sign-in, no person): a crisis answer is not an analytics event.
      void client.reportSelfCheckCrisis(test.id)
      setPhase('crisis')
    } else setPhase('result')
  }

  function requestClose() {
    if (phase === 'question' && answered >= INTERRUPT_FROM && !complete) setPhase('interrupt')
    else onClose()
  }

  const header = (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        {/* The sheet's own heading already names the test. */}
        <div className="text-sm text-dim" data-testid="test-subtitle">
          {lengthLine(test)}
        </div>
      </div>
      {/* No way out of the help screen except its three buttons: the result is not opened until one is chosen. */}
      {phase !== 'crisis' && (
        <button type="button" aria-label="Закрыть" className={`${BUTTON} px-2 text-2xl text-dim`} onClick={requestClose} data-testid="test-close">
          ×
        </button>
      )}
    </div>
  )

  return (
    <Modal open onClose={requestClose} title={test.title} dismissible={phase === 'question' || phase === 'result'} className="max-h-[calc(100dvh-1rem)] overflow-y-auto">
      {header}

      {phase === 'question' && (
        <div className="flex flex-col gap-3" data-testid="test-question">
          <div className="text-sm font-semibold text-brand-400" data-testid="test-progress-label">
            Вопрос {step + 1} из {total}
          </div>
          <div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={step} className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-brand" style={{ width: `${(step / total) * 100}%` }} />
          </div>
          <p className="text-sm text-dim">{test.preface}</p>
          <h2 className="text-lg font-semibold text-foreground" data-testid="test-item">
            {test.items[step]?.text}
          </h2>
          <div className="flex flex-col gap-2">
            {test.options.map((o) => (
              <button
                key={o.value}
                type="button"
                data-testid={`test-option-${o.value}`}
                aria-pressed={answers[step] === o.value}
                onClick={() => answer(o.value)}
                className={`${BUTTON} min-h-12 rounded-lg border px-4 py-3 text-base ${answers[step] === o.value ? 'border-brand bg-brand/20' : 'border-line-strong'}`}
              >
                {o.label}
              </button>
            ))}
          </div>
          {step > 0 && (
            <button
              type="button"
              className={`${BUTTON} self-start text-sm text-dim`}
              data-testid="test-back"
              onClick={() => {
                track(AnalyticsEvent.SelfCheckStepBack, { test_id: test.id })
                setStep(step - 1)
              }}
            >
              ← Назад
            </button>
          )}
          <p className="text-xs text-faint">Ответы остаются на этом устройстве.</p>
        </div>
      )}

      {phase === 'interrupt' && (
        <div className="flex flex-col gap-3 text-center" data-testid="test-interrupt">
          <h2 className="text-lg font-semibold">Прервать тест?</h2>
          <p className="text-dim">Ответы не сохранятся.</p>
          <Button
            className={BUTTON}
            data-testid="test-continue"
            onClick={() => {
              track(AnalyticsEvent.SelfCheckInterruptChoice, { test_id: test.id, action: 'continue', progress: progressOf(step, total) })
              setPhase('question')
            }}
          >
            Продолжить тест
          </Button>
          <Button
            variant="outline"
            className={BUTTON}
            data-testid="test-abort"
            onClick={() => {
              track(AnalyticsEvent.SelfCheckInterruptChoice, { test_id: test.id, action: 'abort', progress: progressOf(step, total) })
              onClose()
            }}
          >
            Прервать
          </Button>
        </div>
      )}

      {phase === 'crisis' && (
        <div className="flex flex-col gap-3 text-center" data-testid="test-crisis" role="alertdialog" aria-label="Помощь">
          <h2 className="text-xl font-semibold">Ты отметил(а), что бывают мысли о смерти или о том, чтобы навредить себе</h2>
          <p className="text-dim">С этим не нужно справляться одному. Если тяжело прямо сейчас — позвони, это бесплатно и анонимно.</p>
          {/* No event for any of these: a crisis answer is never reported and never tied to a person. */}
          <Button variant="outline" className={`${BUTTON} border-sos text-sos`} data-testid="crisis-call" onClick={() => openSos()}>
            Позвонить
          </Button>
          <Button className={BUTTON} data-testid="crisis-talk" onClick={() => router.push('/')}>
            Поговорить с Рядом
          </Button>
          <Button variant="outline" className={BUTTON} data-testid="crisis-result" onClick={() => setPhase('result')}>
            Посмотреть результат
          </Button>
          <p className="text-xs text-faint">Этот ответ не сохраняется и не передаётся.</p>
        </div>
      )}

      {phase === 'result' && <Result test={test} answers={answers as number[]} onClose={onClose} />}
    </Modal>
  )
}

type ResultStep = 'result' | 'consent'

function Result({ test, answers, onClose }: { test: SelfCheckTest; answers: number[]; onClose(): void }) {
  const client = useClient()
  const notify = useNotice()
  const { refresh } = useSelfCheck()
  const result = scoreOf(test, answers)
  const level = bandOf(test, result.score)
  const high = isHigh(test, result.score)
  const weeks = retakeAfterDays(test, result.score) / 7
  const index = level ? test.bands.indexOf(level) : -1
  const [copied, setCopied] = useState(false)
  const [step, setStep] = useState<ResultStep>('result')
  const [saving, setSaving] = useState(false)

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

  /** The server recounts the answers and keeps only the score; without the consent on record the sheet of consent comes first. */
  async function save(withConsent: boolean) {
    setSaving(true)
    try {
      if (!withConsent) {
        const { given } = await client.getSelfCheckConsent()
        if (!given) {
          track(AnalyticsEvent.SelfCheckConsentShown)
          setStep('consent')
          return
        }
      } else {
        await client.giveSelfCheckConsent(SELF_CHECK_CONSENT_VERSION)
        track(AnalyticsEvent.SelfCheckConsentChoice, { action: 'accepted' })
      }
      const saved = await client.saveSelfCheckResult({ testId: test.id, testVersion: test.version, answers })
      if (!saved.ok) {
        if (saved.code === SelfCheckApiErrorCode.CONSENT_REQUIRED) {
          track(AnalyticsEvent.SelfCheckConsentShown)
          setStep('consent')
          return
        }
        throw new Error(saved.code)
      }
      track(AnalyticsEvent.SelfCheckResultAction, { test_id: test.id, action: 'save' })
      notify('Результат сохранён. Он виден в «Самопроверке» и на экране теста.', 'success')
      refresh()
      onClose()
    } catch {
      // The same toast as the success, in red; the result stays on the screen to try again.
      track(AnalyticsEvent.SelfCheckSaveFailed, { test_id: test.id })
      notify('Не получилось сохранить. Повтори ещё раз.', 'error')
      setStep('result')
    } finally {
      setSaving(false)
    }
  }

  if (step === 'consent') {
    return (
      <div className="flex flex-col gap-3" data-testid="test-consent">
        <h2 className="text-lg font-semibold">Сохранить результат?</h2>
        <p className="text-dim">Результаты тестов — сведения о самочувствии.</p>
        <ul className="flex flex-col gap-1 text-[0.9375rem]">
          {['Хранятся в России', 'Видны только тебе', 'Агент их не читает', 'Можно удалить в любой момент'].map((t) => (
            <li key={t}>✓ {t}</li>
          ))}
        </ul>
        <p className="text-xs text-faint">Сохраняем только балл, уровень и дату. Ответы на вопросы не хранятся.</p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className={`${BUTTON} flex-1`}
            data-testid="consent-decline"
            onClick={() => {
              track(AnalyticsEvent.SelfCheckConsentChoice, { action: 'declined' })
              setStep('result')
            }}
          >
            Не сохранять
          </Button>
          <Button className={`${BUTTON} flex-1`} disabled={saving} data-testid="consent-accept" onClick={() => void save(true)}>
            Сохранить
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="test-result">
      <h2 className="text-lg font-semibold">Результат</h2>
      <div className="text-5xl font-bold" data-testid="result-score">
        {result.score} <span className="text-xl font-normal text-dim">/ {result.max}</span>
      </div>
      {result.subscales.length > 0 && (
        <ul className="text-sm text-dim">
          {result.subscales.map((s) => (
            <li key={s.id}>
              {s.label}: {s.score}
            </li>
          ))}
        </ul>
      )}
      {level && (
        <span
          className="self-start rounded-full px-3 py-1 text-sm font-semibold"
          style={{ background: `${TONE_COLOR[level.tone]}33`, color: TONE_COLOR[level.tone] }}
          data-testid="result-level"
        >
          {level.label}
        </span>
      )}
      <div className="flex gap-1" aria-hidden>
        {test.bands.map((b, i) => (
          <i key={b.from} className="h-2.5 flex-1 rounded-full" style={{ background: TONE_COLOR[b.tone], opacity: i === index ? 1 : 0.35 }} />
        ))}
      </div>
      {level && <p className="text-[0.9375rem] text-dim">{level.text}</p>}
      {high && (
        <Link href="/people" className={`${BUTTON} rounded-lg border border-line-strong p-4`} data-testid="result-specialist">
          <div className="font-semibold">Поговорить со специалистом</div>
          <div className="text-sm text-dim">Подберём человека в разделе «Люди рядом»</div>
        </Link>
      )}
      <p className="text-sm text-dim" data-testid="result-retake">
        Повтори тест через {weeks} {plural(weeks, ['неделю', 'недели', 'недель'])} — так видно динамику.
      </p>
      <p className="text-xs text-faint">{DISCLAIMER}</p>
      <p className="text-xs text-faint" data-testid="result-source">
        Источник: {test.source}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          className={`${BUTTON} flex-1`}
          data-testid="result-close"
          onClick={() => {
            track(AnalyticsEvent.SelfCheckResultAction, { test_id: test.id, action: 'close' })
            onClose()
          }}
        >
          Закрыть
        </Button>
        <Button className={`${BUTTON} flex-1`} disabled={saving} data-testid="result-save" onClick={() => void save(false)}>
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </Button>
      </div>
      <button type="button" className={`${BUTTON} text-sm text-dim`} data-testid="result-copy" onClick={copy}>
        {copied ? 'Скопировано' : 'Скопировать итог для специалиста'}
      </button>
    </div>
  )
}
