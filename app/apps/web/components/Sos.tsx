'use client'

import { Phone } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { trackAnonymous } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import type { HotlineApiResponse } from '@ryadom/contracts/api/dialogs'
import {
  CALL_NOW_HOTLINE,
  CRISIS_TEXT,
  OTHER_HOTLINES,
  crisisStore,
  type SheetRequest,
} from '@ryadom/client-core/crisis'
import { HOTLINES, telHref } from '@ryadom/client-core/hotlines'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { BUTTON } from './controls'
import Hotline from './Hotline'
import Modal from './Modal'

/**
 * Help lines are reachable from every signed-in screen. The default list is bundled
 * and works offline; a `safety` frame from the dialog may pass its own text and list.
 */

export interface SosPayload {
  text?: string | null
  hotlines?: HotlineApiResponse[]
  /** The crisis script's sheet (`help`, `call112`); without it the default sheet. */
  variant?: 'help' | 'call112'
}

interface SosApi {
  openSos(payload?: SosPayload): void
  closeSos(): void
  /** Applies what a `safety` frame asked of the sheet. */
  applySheet(request: SheetRequest, payload?: SosPayload): void
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
  const applySheet = useCallback(
    (request: SheetRequest, next: SosPayload = {}) => {
      if (request === 'close') setOpen(false)
      else if (request) openSos({ ...next, variant: request === 'default' ? undefined : request })
    },
    [openSos],
  )
  const api = useMemo(() => ({ openSos, closeSos, applySheet }), [openSos, closeSos, applySheet])
  useEffect(() => crisisStore.setSheetOpen(open), [open])
  const { ui } = useSyncExternalStore(crisisStore.subscribe, crisisStore.getSnapshot, crisisStore.getSnapshot)

  const hotlines = payload.hotlines?.length ? payload.hotlines : HOTLINES
  const variant = payload.variant
  const answerSafe = (text: string) => {
    crisisStore.answer(text)
  }

  return (
    <SosContext.Provider value={api}>
      {children}
      <Modal
        open={open}
        onClose={closeSos}
        title={variant === 'help' ? CRISIS_TEXT.helpTitle : 'Если сейчас тяжело'}
        className={SHEET}
      >
        {variant === 'help' && (
          <>
            <CallButton hotline={CALL_NOW_HOTLINE} label={CRISIS_TEXT.callNow} testId="sos-call-now" />
            <a
              href={telHref('112')}
              data-testid="sos-call-112"
              className={cn(BUTTON, 'ph-no-capture flex min-h-12 items-center justify-center rounded-xl border border-danger-line px-4 text-center font-semibold text-sos')}
              onClick={() => trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: 'Экстренные службы' })}
            >
              {CRISIS_TEXT.call112}
            </a>
            <button
              type="button"
              data-testid="sos-safe-link"
              className="min-h-11 text-sm text-dim underline"
              onClick={() => {
                answerSafe(CRISIS_TEXT.safeAnswer)
                closeSos()
              }}
            >
              {CRISIS_TEXT.safeLink}
            </button>
          </>
        )}
        {variant === 'call112' && (
          <a
            href={telHref('112')}
            data-testid="sos-call-112-big"
            className={cn(BUTTON, 'ph-no-capture flex min-h-24 items-center justify-center rounded-xl bg-danger-soft text-center text-5xl font-bold text-sos')}
            onClick={() => trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: 'Экстренные службы' })}
          >
            112
          </a>
        )}
        {ui.askSafe && variant !== 'call112' && <SafeAnswers onAnswer={answerSafe} />}
        {!variant && <p className={TEXT}>{payload.text ?? DEFAULT_TEXT}</p>}
        <div className="grid gap-2.5 short-wide:col-start-2 short-wide:row-span-3 short-wide:row-start-1 short-wide:gap-2">
          {(variant ? OTHER_HOTLINES.filter((line) => variant === 'call112' || line !== CALL_NOW_HOTLINE) : hotlines).map(
            (hotline) => (
              <Hotline
                key={hotline.phone}
                hotline={hotline}
                // Snugger rows on a phone held upright (360x640 needs ~600px), snuggest in the two-column sheet.
                className="max-tab:py-3 short-wide:py-1 short-wide:leading-[1.3] short-wide:[&>[data-slot=item-content]]:gap-0"
              />
            ),
          )}
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
      </Modal>
    </SosContext.Provider>
  )
}

/** The main button of the crisis sheet and of the pinned bar: a call to one line. */
export function CallButton({
  hotline,
  label,
  testId,
  className,
}: {
  hotline: HotlineApiResponse
  label: string
  testId: string
  className?: string
}) {
  return (
    <a
      href={telHref(hotline.phone)}
      data-testid={testId}
      className={cn(
        BUTTON,
        'ph-no-capture flex min-h-12 items-center justify-center gap-2 rounded-xl bg-danger-soft px-4 text-center text-lg font-bold text-sos',
        className,
      )}
      onClick={() => trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: hotline.name })}
    >
      <Phone className="size-5" aria-hidden="true" />
      {label}
    </a>
  )
}

/** «Да» · «Нет» · «Не знаю»: ordinary messages with exactly these words. */
export function SafeAnswers({ onAnswer, className }: { onAnswer(text: string): void; className?: string }) {
  return (
    <div className={cn('grid grid-cols-3 gap-2', className)} data-testid="safe-answers">
      {CRISIS_TEXT.askSafe.map((word) => (
        <Button key={word} type="button" variant="outline" className={cn(BUTTON, 'border-input!')} onClick={() => onAnswer(word)}>
          {word}
        </Button>
      ))}
    </div>
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
