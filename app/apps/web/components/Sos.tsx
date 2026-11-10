'use client'

import { Phone } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { trackAnonymous } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import type { HotlineApiResponse } from '@ryadom/contracts/api/dialogs'
import { CRISIS_CALL, CRISIS_SHEET_TITLE, HOTLINES, telHref } from '@ryadom/client-core/hotlines'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { BUTTON, FOCUS_RING } from './controls'
import Hotline from './Hotline'
import Modal from './Modal'

/**
 * Help lines are reachable from every signed-in screen. The default list is bundled
 * and works offline; a `safety` frame from the dialog may pass its own text and list.
 */

export interface SosPayload {
  text?: string | null
  hotlines?: HotlineApiResponse[]
  /** The crisis script (PROTEUS-279): the sheet gets the heading, the "Call now" button and the way back to the conversation. */
  crisis?: { onCall(): void }
}

interface SosApi {
  openSos(payload?: SosPayload): void
  closeSos(): void
}

const SosContext = createContext<SosApi | null>(null)

const DEFAULT_TEXT = 'Позвони по одному из номеров — там ответит человек. Это бесплатно и круглосуточно.'

/*
 * The sheet someone opens in a bad moment must not hide its way out below the fold: nearly the whole
 * height. On a phone on its side (as little as 320px of height, `short-wide:`) the text and the way out
 * go on the left and the three lines are stacked on the right, so the safety sentence and the close
 * button are on screen without scrolling; a single column of everything is about 440px tall.
 */
const SHEET =
  // `ph-no-capture`: what is tapped here is counted without a person (`trackAnonymous`); click autocapture
  // would attach it to one.
  'ph-no-capture max-h-[calc(100dvh-1rem)] short-wide:w-[min(94vw,720px)] short-wide:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] short-wide:grid-rows-[auto_auto_1fr_auto] short-wide:items-start short-wide:gap-x-5'

/** Intro and the safety note: readable tone, and tighter when the sheet is in two columns. */
const TEXT = 'text-base leading-[1.55] text-dim short-wide:text-[0.9375rem] short-wide:leading-[1.4]'

export function SosProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [payload, setPayload] = useState<SosPayload>({})

  const openSos = useCallback((next: SosPayload = {}) => {
    setPayload(next)
    setOpen(true)
  }, [])
  const closeSos = useCallback(() => setOpen(false), [])
  const api = useMemo(() => ({ openSos, closeSos }), [openSos, closeSos])

  const listed = payload.hotlines?.length ? payload.hotlines : HOTLINES
  // In the crisis script 112 has its own line under "Call now"; the list keeps the rest.
  const hotlines = payload.crisis ? listed.filter((hotline) => hotline.phone !== '112') : listed

  return (
    <SosContext.Provider value={api}>
      {children}
      <Modal open={open} onClose={closeSos} title={payload.crisis ? CRISIS_SHEET_TITLE : 'Если сейчас тяжело'} className={SHEET}>
        {payload.crisis ? (
          <div className="grid gap-2.5" data-testid="sos-crisis">
            <Button asChild size="lg" variant="destructive" className={cn(BUTTON, 'w-full gap-2 font-bold')}>
              <a
                href={telHref(CRISIS_CALL.phone)}
                data-testid="sos-call-now"
                onClick={() => {
                  trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: CRISIS_CALL.name })
                  payload.crisis?.onCall()
                }}
              >
                <Phone className="size-4" aria-hidden="true" />
                Позвонить сейчас
              </a>
            </Button>
            <a
              href={telHref('112')}
              className={cn(TEXT, 'text-center underline underline-offset-4')}
              data-testid="sos-112"
              onClick={() => trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: 'Экстренные службы' })}
            >
              112 — если есть опасность для жизни
            </a>
          </div>
        ) : (
          <p className={TEXT}>{payload.text ?? DEFAULT_TEXT}</p>
        )}
        <div className="grid gap-2.5 short-wide:col-start-2 short-wide:row-span-3 short-wide:row-start-1 short-wide:gap-2">
          {hotlines.map((hotline) => (
            <Hotline
              key={hotline.phone}
              hotline={hotline}
              // Snugger rows on a phone held upright (360x640 needs ~600px), snuggest in the two-column sheet.
              className="max-tab:py-3 short-wide:py-1 short-wide:leading-[1.3] short-wide:[&>[data-slot=item-content]]:gap-0"
            />
          ))}
        </div>
        {/* The single most consequential sentence in the app: readable tone, not the faint caption one. */}
        <p className={cn(TEXT, 'short-wide:col-start-1 short-wide:row-span-2 short-wide:row-start-3')}>
          «Рядом»&nbsp;— сервис самоподдержки, не медицинская услуга. В опасной ситуации звони 112.
        </p>
        {/* An explicit button: this opens at a hard moment, so the way out must be visible. */}
        <Button
          type="button"
          variant="outline"
          className={cn(
            BUTTON,
            // The glass in `outline` redraws the border as the faint hairline; a control keeps its 3:1 edge.
            'w-full border-input! leading-[1.2] short-wide:col-start-2 short-wide:row-start-4 short-wide:h-11',
          )}
          onClick={closeSos}
        >
          Закрыть
        </Button>
        {payload.crisis && (
          <button
            type="button"
            className={cn(TEXT, 'text-xs underline underline-offset-4 short-wide:col-start-1', FOCUS_RING)}
            onClick={closeSos}
            data-testid="sos-safe"
          >
            Я в безопасности, давай продолжим
          </button>
        )}
      </Modal>
    </SosContext.Provider>
  )
}

export function useSos(): SosApi {
  const ctx = useContext(SosContext)
  if (!ctx) throw new Error('useSos must be used inside SosProvider')
  return ctx
}

/** Pill button that opens the sheet. It sits in the header of every screen (AppHeader), the one place SOS lives. */
export function SosButton({ className }: { className?: string }) {
  const { openSos } = useSos()
  return (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      // The generic danger text is a shade lighter than the SOS red; hover only brightens, as before. The
      // product focus ring replaces the variant's faint red one: this is the control to find in a bad moment.
      className={cn(
        BUTTON,
        'ph-no-capture gap-1.5 bg-clip-border px-4 text-[0.8125rem] font-bold tracking-[0.04em] text-sos hover:bg-danger-soft hover:brightness-120 focus-visible:border-danger-line',
        className,
      )}
      onClick={() => {
        // A count of how often SOS is opened, attached to nobody.
        trackAnonymous(AnalyticsEvent.SosOpened, { source: 'header' })
        openSos()
      }}
    >
      <Phone className="size-3.5" aria-hidden="true" />
      SOS
    </Button>
  )
}
