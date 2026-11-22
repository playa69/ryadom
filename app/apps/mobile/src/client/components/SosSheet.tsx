import { trackAnonymous } from '@ryadom/analytics/browser'
import { AnalyticsEvent, type AnalyticsEventProperties } from '@ryadom/analytics/events'
import { Button, Icon, Sheet, f7 } from 'framework7-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { HotlineApiResponse } from '@ryadom/contracts/api/dialogs'
import { CRISIS_CALL, CRISIS_SHEET_TITLE, HOTLINES, telHref } from '../lib/hotlines'

/**
 * Help lines (SOS is reachable from any screen, and the lines are one tap away).
 *
 * Opened by the SOS button and by a `safety` frame from the dialog. The default list is bundled
 * into the app and works with no network; when the agent sends its own list, that one is shown.
 */

const SOS_EVENT = 'ryadom:sos'
const openListeners = new Set<() => void>()
let sheetOpen = false

function setSheetOpen(open: boolean): void {
  if (sheetOpen === open) return
  sheetOpen = open
  for (const listener of openListeners) listener()
}

function subscribeSos(listener: () => void): () => void {
  openListeners.add(listener)
  return () => openListeners.delete(listener)
}

export function isSosOpen(): boolean {
  return sheetOpen
}

export function useSosOpened(): boolean {
  return useSyncExternalStore(subscribeSos, isSosOpen)
}

export type SosSource = AnalyticsEventProperties[AnalyticsEvent.SosOpened]['source']

export interface SosPayload {
  text?: string | null
  hotlines?: HotlineApiResponse[]
  /** Where it was opened from, for analytics (counted without the person: see trackAnonymous). */
  source?: SosSource
  /** The crisis script (PROTEUS-279): heading, "Call now" and the way back to the conversation. */
  crisis?: { onCall(): void }
}

/** Open the help sheet from anywhere: the SOS button or a safety frame. */
export function openSos(payload: SosPayload = {}): void {
  setSheetOpen(true)
  window.dispatchEvent(new CustomEvent<SosPayload>(SOS_EVENT, { detail: payload }))
}

/**
 * Pass `slot="fixed"` on a page that also renders a Navbar. Framework7 only lifts children with
 * a known slot name (navbar, toolbar, fixed, …) out of `.page-content`; anything else, including
 * this button by default, ends up inside it. `.page-content` is a stacking context of its own
 * (`position: relative; z-index: 1`), so a button trapped inside it can never out-rank the
 * navbar's `z-index: 500` no matter how high we set `.rd-sos-button`'s own z-index — the sibling
 * navbar wins by being outside that context entirely, not by a higher number. On pages with no
 * navbar (Home) the default slot happens to look right, which is why this went unnoticed there.
 */
export function SosButton({ slot, source }: { slot?: string; source: SosSource }) {
  return (
    <button type="button" className="rd-sos-button ph-no-capture" slot={slot} onClick={() => openSos({ source })}>
      <Icon f7="phone_fill" size={15} />
      SOS
    </button>
  )
}

export default function SosSheet() {
  const [opened, setOpened] = useState(false)
  const [payload, setPayload] = useState<SosPayload>({})
  const specialistsRequested = useRef(false)

  useEffect(() => {
    function handler(event: Event) {
      const detail = (event as CustomEvent<SosPayload>).detail ?? {}
      setPayload(detail)
      setOpened(true)
      // Counted, not attributed: opening this sheet must not become a mark on the account.
      if (detail.source) trackAnonymous(AnalyticsEvent.SosOpened, { source: detail.source })
    }
    window.addEventListener(SOS_EVENT, handler)
    return () => {
      window.removeEventListener(SOS_EVENT, handler)
      setSheetOpen(false)
    }
  }, [])

  const listed = payload.hotlines?.length ? payload.hotlines : HOTLINES
  // In the crisis script 112 has its own line under "Call now"; the list keeps the rest.
  const hotlines = payload.crisis ? listed.filter((hotline) => hotline.phone !== '112') : listed

  return (
    <Sheet
      className="ph-no-capture"
      opened={opened}
      onSheetClosed={() => {
        setOpened(false)
        setSheetOpen(false)
        if (specialistsRequested.current) {
          specialistsRequested.current = false
          const view = f7.views.current ?? f7.views.main
          const heading = view.el.querySelector<HTMLElement>('.page-current[data-name="people"] #specialists')
          if (heading) {
            heading.focus({ preventScroll: true })
            heading.scrollIntoView()
          } else {
            view.router.navigate('/people/?section=specialists')
          }
        }
      }}
      swipeToClose
      closeOnEscape
      backdrop
      style={{ height: 'auto' }}
    >
      <div className="rd-sheet-body rd-sos-sheet">
        <div className="rd-sos-sheet-content">
          <h2 className="rd-sheet-title">{payload.crisis ? CRISIS_SHEET_TITLE : 'Если сейчас тяжело'}</h2>
          {payload.crisis ? (
            <>
              <a
                className="rd-crisis-call ph-no-capture"
                data-testid="sos-call-now"
                href={telHref(CRISIS_CALL.phone)}
                onClick={() => {
                  trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: CRISIS_CALL.name })
                  payload.crisis?.onCall()
                }}
              >
                <Icon f7="phone_fill" size={16} />
                Позвонить сейчас
              </a>
              <a
                className="rd-muted rd-crisis-112 ph-no-capture"
                data-testid="sos-112"
                href={telHref('112')}
                onClick={() => trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: 'Экстренные службы' })}
              >
                112 — если есть опасность для жизни
              </a>
            </>
          ) : (
            <p className="rd-muted">
              {payload.text ??
                'Позвони по одному из номеров — там ответит человек. Это бесплатно и круглосуточно.'}
            </p>
          )}
          {hotlines.map((hotline) => (
            <a
              key={hotline.phone}
              className="rd-hotline ph-no-capture"
              href={telHref(hotline.phone)}
              onClick={() => trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: hotline.name })}
            >
              <span className="rd-hotline-name">{hotline.name}</span>
              <span className="rd-hotline-phone">{hotline.phone}</span>
            </a>
          ))}
          {/* This is the single most consequential sentence in the app, so it uses the readable
              muted tone rather than the faint caption one: --ryadom-text-faint fails contrast on
              this surface (design review). */}
          <p className="rd-muted">
            «Рядом»&nbsp;— сервис самоподдержки, не медицинская услуга. В опасной ситуации звони 112.
          </p>
          <p className="rd-muted rd-sos-specialists">
            Не кризис, но хочется поговорить с живым человеком?{' '}
            <a
              className="rd-inline-link external"
              href="/people/?section=specialists"
              onClick={(event) => {
                event.preventDefault()
                specialistsRequested.current = true
                setOpened(false)
              }}
            >
              <span aria-hidden="true">→ </span>Специалисты
            </a>
          </p>
        </div>
        {/* An explicit button rather than tap-outside-to-close: this sheet opens at a hard moment,
            so the way out has to be visible. */}
        <Button large outline onClick={() => setOpened(false)}>
          Закрыть
        </Button>
        {payload.crisis && (
          <button type="button" className="rd-inline-link rd-crisis-safe" data-testid="sos-safe" onClick={() => setOpened(false)}>
            Я в безопасности, давай продолжим
          </button>
        )}
      </div>
    </Sheet>
  )
}
