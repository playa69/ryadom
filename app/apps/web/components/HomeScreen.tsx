'use client'

import { BookOpen, Heart, MessageCircle, Moon, type LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { DialogMode, StartDialogApiErrorCode } from '@ryadom/contracts/api/dialogs'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import { Badge } from '@ryadom/ui/components/badge'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { useAuth, useClient } from '@/lib/auth'
import { AppHeader } from './AppHeader'
import Breathing from './Breathing'
import ChatComposer from './ChatComposer'
import { BUTTON, FOCUS_RING } from './controls'
import { rememberDialogStart } from './dialog-start'
import { unlockSpeech } from '@ryadom/client-core/voice/speech'

/**
 * Home as the empty state of a chat app: the breathing sphere, a greeting, and the
 * input box in the middle of the page. Sending starts a conversation and carries the typed text
 * over as its first message; with nothing typed, "Поговорить" and the microphone both start one
 * that opens on the voice and begins listening.
 *
 * In v0 only the venting mode works. The other modes exist in the contract, but enabling them
 * before the agent supports them would be a promise the product cannot keep.
 */

const MODES: Array<{ id: DialogMode; label: string; icon: LucideIcon; ready: boolean }> = [
  { id: DialogMode.Vent, label: 'Выговориться', icon: Heart, ready: true },
  { id: DialogMode.Chat, label: 'Поболтать', icon: MessageCircle, ready: false },
  { id: DialogMode.Journal, label: 'Дневник', icon: BookOpen, ready: false },
  { id: DialogMode.RitualEvening, label: 'Вечерний ритуал', icon: Moon, ready: false },
]

const START_ERRORS: Record<StartDialogApiErrorCode, string> = {
  [StartDialogApiErrorCode.USER_NOT_FOUND]: 'Аккаунт недоступен. Войди заново',
  [StartDialogApiErrorCode.USER_INACTIVE]: 'Аккаунт заблокирован. Напиши нам, разберёмся',
  [StartDialogApiErrorCode.CONSENT_REQUIRED]: 'Сначала нужно подтвердить согласие',
}

function greeting(name: string | null): string {
  const hour = new Date().getHours()
  const part =
    hour < 5 ? 'Поздний вечер' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер'
  return name ? `${part}, ${name}` : part
}

export default function HomeScreen() {
  const { user, updateUser } = useAuth()
  const client = useClient()
  const router = useRouter()
  const [mode, setMode] = useState<DialogMode>(DialogMode.Vent)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** A ref beside the state: two presses in one tick would both see `loading` as still false. */
  const starting = useRef(false)
  /** Not mounted any more (the person went elsewhere while the request was out): nothing is handed over. */
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function start(draft: string, listen: boolean) {
    if (starting.current) return
    // A conversation that opens on the voice has the sphere speak first: this press lets speech through.
    unlockSpeech()
    starting.current = true
    setError('')
    setLoading(true)
    let leaving = false
    try {
      const result = await client.startDialog(mode)
      // The handoff is armed only for a screen that is still here to push to the dialog: one armed for a
      // person who has left would wait for the next visit to that dialog and send the draft then.
      if (!alive.current) return
      if (!result.ok) {
        // The server has no agreement on record for this account: forget what was cached, and the
        // app's gate takes the person through the first screen.
        if (result.code === StartDialogApiErrorCode.CONSENT_REQUIRED) updateUser({ consentVersion: null })
        setError(codeText(START_ERRORS, result.code, 'Не получилось начать разговор'))
        return
      }
      rememberDialogStart(
        result.data.dialogId,
        {
          greeting: result.data.greeting,
          resumed: result.data.resumed,
          sinceLastDialogHours: result.data.sinceLastDialogHours,
        },
        { draft, listen },
      )
      router.push(`/dialog/${encodeURIComponent(result.data.dialogId)}`)
      leaving = true
    } catch (err) {
      if (alive.current) setError(apiErrorText(err, {}, 'Не получилось начать разговор'))
    } finally {
      // After a successful start the box stays busy until this screen unmounts: the navigation takes a
      // moment, and a press in that gap would start a second request and arm the same draft twice.
      if (!leaving) {
        starting.current = false
        setLoading(false)
      }
    }
  }

  return (
    <>
      <AppHeader title="Новый разговор" titleIsHeading={false} />
      {/*
        Two parts split 4:6 at one fixed line: the sphere and the greeting sit above it, the box and
        what follows below. The box's top edge therefore stays put while a long draft grows it
        downward, instead of the whole stack drifting up around a middle.
      */}
      <div className="flex flex-1 flex-col px-4 tab:px-6">
        <div className="flex flex-[4] flex-col items-center justify-end gap-4 pt-6 pb-6 short:gap-2 short:pt-3 short:pb-3">
          <div data-testid="home-orb">
            <Breathing className="w-24 tab:w-28 short:w-16" />
          </div>

          <div className="flex max-w-xl flex-col items-center gap-2 text-center">
            <h1
              className="text-2xl leading-tight font-bold tracking-display-tight text-balance text-foreground wrap-anywhere tab:text-3xl"
              data-testid="home-greeting"
            >
              {greeting(user?.name ?? null)}
            </h1>
            <p className="text-base leading-[1.55] text-dim text-balance tab:text-lg">
              Я здесь и никуда не спешу. О чём хочется сказать?
            </p>
          </div>
        </div>

        <div className="flex flex-[6] flex-col items-center gap-4 pb-[calc(2rem+env(safe-area-inset-bottom,0px))] short:gap-3 short:pb-6">
          <div className="w-full max-w-3xl">
            <ChatComposer
              variant="hero"
              testIdPrefix="home"
              placeholder="Напиши или скажи, что на душе…"
              busy={loading}
              emptyLabel="Поговорить"
              keepDraft
              autoFocus
              // Typed words open the text, with those words as the first message; "Поговорить" without any, like the
              // microphone, opens the voice and starts listening: the conversation is talked first.
              onSubmit={(text) => void start(text, text === '')}
              onMic={(text) => void start(text, true)}
            />
          </div>

          {/* A start that failed must be seen where the person is looking: right under the box. */}
          {error && (
            <p
              className="max-w-[40ch] text-center text-base leading-snug text-danger"
              role="alert"
              data-testid="form-error"
            >
              {error}
            </p>
          )}

          {/* Capped at the width of two chips per row until all four fit in one, so a narrow window gets a 2 + 2 grid, not 3 + 1. */}
          <div
            role="group"
            aria-label="О чём поговорим"
            className="flex max-w-md flex-wrap justify-center gap-2 min-[1056px]:max-w-3xl"
          >
            {MODES.map(({ id, label, icon: ModeIcon, ready }) => (
              <Button
                key={id}
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={mode === id}
                disabled={!ready}
                onClick={() => setMode(id)}
                data-testid="home-mode"
                className={cn(
                  BUTTON,
                  // `outline-none`: the shared button's transparent outline would paint a second ring in forced-colors modes.
                  'outline-none',
                  // Not dimmed when disabled: the "скоро" mark is information, so the text keeps its readable tone.
                  'gap-1.5 border-input! px-3.5 text-sm text-dim disabled:opacity-100 enabled:hover:text-foreground',
                  // A phone: tighter chips so the four of them make two rows of two, not a ragged 2 + 1 + 1.
                  'max-[26rem]:gap-1 max-[26rem]:px-2.5 max-[26rem]:text-[0.8125rem]',
                  'aria-pressed:border-brand-line! aria-pressed:bg-brand-soft aria-pressed:text-foreground',
                )}
              >
                <ModeIcon
                  aria-hidden="true"
                  className={cn('size-4', mode === id && ready && 'text-brand-400')}
                />
                {label}
                {/* Hover text would never show on touch; a mode that is not ready has to say so in plain sight. */}
                {!ready && (
                  <Badge
                    variant="outline"
                    className="h-5 px-1.5 font-semibold text-faint max-[26rem]:px-1 max-[26rem]:text-[0.6875rem]"
                  >
                    скоро
                  </Badge>
                )}
              </Button>
            ))}
          </div>

          <div className="flex max-w-[52ch] flex-col items-center pt-2 text-center short:pt-0">
            <p className="text-xs leading-normal text-faint">
              «Рядом»&nbsp;— самоподдержка, не психотерапия. В опасной ситуации звони&nbsp;112.
            </p>
            {/* A padded link: a line of text is 16px high, a finger needs 44. */}
            <Link
              href="/people"
              className={cn(
                FOCUS_RING,
                'inline-flex min-h-11 items-center rounded-sm px-3 text-sm text-dim underline underline-offset-4 outline-none hover:text-foreground',
              )}
            >
              Люди рядом&nbsp;— линии помощи
            </Link>
          </div>
        </div>
      </div>
    </>
  )
}
