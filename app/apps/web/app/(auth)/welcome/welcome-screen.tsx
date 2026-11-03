'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import { DIALOG_KEEP_NOTE, GUEST_LIFE_CLAUSE } from '@ryadom/client-core/retention'
import { unlockSpeech } from '@ryadom/client-core/voice/speech'
import { DialogMode, StartDialogApiErrorCode } from '@ryadom/contracts/api/dialogs'
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { Button } from '@ryadom/ui/components/button'
import Breathing from '@/components/Breathing'
import { Wordmark } from '@/components/Brand'
import ChatComposer from '@/components/ChatComposer'
import { rememberDialogStart } from '@/components/dialog-start'
import { formOutcome, trackForm } from '@/lib/analytics'
import { useAuth, useClient } from '@/lib/auth'
import { useAuthFlow } from '../auth-flow'
import { ConsentNotice } from '../_components/consent-group'
import { PRIMARY_BUTTON } from '../_components/parts'

const START_FALLBACK = 'Не получилось начать разговор. Попробуй ещё раз'

const START_ERRORS: Record<StartDialogApiErrorCode, string> = {
  [StartDialogApiErrorCode.USER_NOT_FOUND]: 'Аккаунт недоступен. Войди заново',
  [StartDialogApiErrorCode.USER_INACTIVE]: 'Аккаунт заблокирован. Напиши нам, разберёмся',
  [StartDialogApiErrorCode.CONSENT_REQUIRED]: START_FALLBACK,
}

function partOfDay(): string {
  const hour = new Date().getHours()
  return hour < 5 ? 'Поздний вечер' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер'
}

/**
 * The first screen. Someone new meets home itself: the sphere, the box to write or speak, and under it
 * what starting means. The first message or the microphone is the agreement: that press makes an
 * account for this device behind the scenes, records the consents, starts the conversation and opens
 * it, where the companion greets the person. Nothing is sent before that press.
 *
 * The same screen is also the gate for someone who is already signed in but has not agreed to the
 * current version of the terms (an account from before this screen existed, or a newer version of the
 * terms): there it only records the agreement on "Продолжить" and goes on to home.
 */
export default function WelcomeScreen() {
  const { status, user, startAnonymously, acceptConsents } = useAuth()
  const client = useClient()
  const { termsUrl, privacyUrl } = useAuthFlow()
  const router = useRouter()
  const starting = useRef(false)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState('')
  // Computed in the browser only: the server's clock and time zone are not the person's.
  const [hello, setHello] = useState('')
  useEffect(() => setHello(partOfDay()), [])

  const signedIn = status === 'authenticated'
  // Agreed already (the gate just recorded it, or another tab did): nothing is left to ask. A start under
  // way agrees on its own and moves on to the conversation, not home.
  const agreed = signedIn && user?.consentVersion === POLICY_VERSION
  useEffect(() => {
    if (agreed && !starting.current) router.replace('/home')
  }, [agreed, router])

  function fail(text: string) {
    starting.current = false
    setLoading(false)
    setProblem(text)
  }

  async function start(draft: string, listen: boolean) {
    if (starting.current) return
    // The conversation opens on the voice and the sphere speaks first: this press lets speech through.
    unlockSpeech()
    starting.current = true
    setProblem('')
    setLoading(true)
    if (!signedIn) {
      track(AnalyticsEvent.CtaClicked, { cta: 'start_anonymous', placement: 'welcome' })
      try {
        await startAnonymously({ consent: true })
        trackForm('device_start', 'success')
      } catch (err) {
        trackForm('device_start', formOutcome(err))
        return fail(apiErrorText(err, {}, START_FALLBACK))
      }
    }
    try {
      const result = await client.startDialog(DialogMode.Vent)
      if (!result.ok) return fail(codeText(START_ERRORS, result.code, START_FALLBACK))
      const data = result.data
      rememberDialogStart(
        data.dialogId,
        {
          greeting: data.greeting,
          resumed: data.resumed,
          sinceLastDialogHours: data.sinceLastDialogHours,
          memoryMode: data.memoryMode,
          saved: data.saved,
          memoryEnabled: data.memoryEnabled,
        },
        { draft, listen },
      )
      // Replace, not push: "back" from the conversation must not land on a first screen that is over.
      router.replace(`/dialog/${encodeURIComponent(data.dialogId)}`)
    } catch (err) {
      fail(apiErrorText(err, {}, START_FALLBACK))
    }
  }

  async function agree() {
    if (starting.current) return
    starting.current = true
    setProblem('')
    setLoading(true)
    // On success the effect above sees the recorded version and moves on.
    if (!(await acceptConsents())) fail('Не получилось сохранить согласие. Попробуй ещё раз')
    else starting.current = false
  }

  // A signed-in person without the current agreement; not while a start of someone new is under way,
  // which passes through this state for a moment.
  const gate = signedIn && !agreed && !loading

  return (
    <div className="flex min-h-dvh flex-col" data-testid="welcome">
      <header className="flex items-center justify-between gap-4 pt-[max(1rem,env(safe-area-inset-top,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))] pl-[max(1rem,env(safe-area-inset-left,0px))] tab:px-6">
        <Wordmark className="text-[22px]" />
        {!signedIn && (
          <Button asChild variant="outline" className="h-10 rounded-full px-5 text-sm">
            <Link
              href="/login"
              data-testid="have-account"
              onClick={() => track(AnalyticsEvent.CtaClicked, { cta: 'login', placement: 'welcome' })}
            >
              Войти
            </Link>
          </Button>
        )}
      </header>

      <main className="flex flex-1 flex-col px-4 tab:px-6">
        <div className="flex flex-[4] flex-col items-center justify-end gap-4 pt-6 pb-6 short:gap-2 short:pt-3 short:pb-3">
          <Breathing className="w-24 tab:w-28 short:w-16" />
          <div className="flex max-w-xl flex-col items-center gap-2 text-center">
            <h1 className="min-h-[1.25em] text-2xl leading-tight font-bold tracking-display-tight text-balance text-foreground tab:text-3xl">
              {hello}
            </h1>
            <p className="text-base leading-[1.55] text-dim text-balance tab:text-lg">
              {gate
                ? 'Один раз подтверди, что согласен(на), — и можно говорить.'
                : 'Я здесь и никуда не спешу. О чём хочется сказать?'}
            </p>
          </div>
        </div>

        <div className="flex flex-[6] flex-col items-center gap-4 pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))] short:gap-3 short:pb-4">
          {gate ? (
            <div className="w-full max-w-md">
              <Button
                type="button"
                className={PRIMARY_BUTTON}
                aria-busy={loading || undefined}
                onClick={() => void agree()}
                data-testid="welcome-continue"
              >
                Продолжить
              </Button>
            </div>
          ) : (
            <div className="w-full max-w-3xl">
              <ChatComposer
                variant="hero"
                testIdPrefix="welcome"
                placeholder="Напиши или скажи, что на душе…"
                busy={loading}
                emptyLabel="Поговорить"
                keepDraft
                autoFocus
                // Typed words open the text, with those words as the first message; "Поговорить" without any,
                // like the microphone, opens the voice and starts listening: the conversation is talked first.
                onSubmit={(text) => void start(text, text === '')}
                onMic={(text) => void start(text, true)}
              />
            </div>
          )}

          {problem && (
            <p
              className="max-w-[40ch] text-center text-base leading-snug text-danger"
              role="alert"
              data-testid="form-error"
            >
              {problem}
            </p>
          )}

          <ConsentNotice
            action={gate ? 'Продолжить' : undefined}
            termsUrl={termsUrl}
            privacyUrl={privacyUrl}
            className="max-w-2xl text-center"
          />
          {/* Before any agreement, as on home: the way to help in danger needs no account. */}
          <p className="text-center text-xs leading-normal text-dim">В опасной ситуации звони 112.</p>

          {!signedIn && (
            <p className="mt-auto max-w-xl pt-4 text-center text-xs leading-normal text-faint text-balance">
              {DIALOG_KEEP_NOTE} Без почты аккаунт {GUEST_LIFE_CLAUSE}. Привязать почту можно в любой момент в
              профиле.
            </p>
          )}
        </div>
      </main>
    </div>
  )
}
