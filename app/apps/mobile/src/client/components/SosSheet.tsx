import { trackAnonymous } from '@ryadom/analytics/browser'
import { AnalyticsEvent, type AnalyticsEventProperties } from '@ryadom/analytics/events'
import { Button, Icon, Sheet } from 'framework7-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { HotlineApiResponse } from '@ryadom/contracts/api/dialogs'
import { CALL_NOW_HOTLINE, CRISIS_TEXT, OTHER_HOTLINES, crisisStore, type SheetRequest } from '@ryadom/client-core/crisis'
import { HOTLINES, telHref } from '../lib/hotlines'

/**
 * Help lines (SOS is reachable from any screen, and the lines are one tap away).
 *
 * Opened by the SOS button and by a `safety` frame from the dialog. The default list is bundled
 * into the app and works with no network; when the agent sends its own list, that one is shown.
 */

const SOS_EVENT = 'ryadom:sos'

export type SosSource = AnalyticsEventProperties[AnalyticsEvent.SosOpened]['source']

export interface SosPayload {
  text?: string | null
  hotlines?: HotlineApiResponse[]
  /** The crisis script's sheet (`help`, `call112`); without it the default sheet. */
  variant?: 'help' | 'call112'
  /** Where it was opened from, for analytics (counted without the person: see trackAnonymous). */
  source?: SosSource
}

/** Open the help sheet from anywhere: the SOS button or a safety frame. */
export function openSos(payload: SosPayload = {}): void {
  window.dispatchEvent(new CustomEvent<SosPayload>(SOS_EVENT, { detail: payload }))
}

const CLOSE_EVENT = 'ryadom:sos-close'

/** Applies what a `safety` frame asked of the sheet. */
export function applySheet(request: SheetRequest, payload: SosPayload = {}): void {
  if (request === 'close') window.dispatchEvent(new Event(CLOSE_EVENT))
  else if (request) openSos({ ...payload, variant: request === 'default' ? undefined : request })
}

/** The main button of the crisis sheet and of the pinned bar: a call to one line. */
export function CallButton({ hotline, label, testId, className }: { hotline: HotlineApiResponse; label: string; testId: string; className?: string }) {
  return (
    <a
      href={telHref(hotline.phone)}
      data-testid={testId}
      className={`rd-call-button ph-no-capture${className ? ` ${className}` : ''}`}
      onClick={() => trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: hotline.name })}
    >
      <Icon f7="phone_fill" size={18} />
      {label}
    </a>
  )
}

/** «Да» · «Нет» · «Не знаю»: ordinary messages with exactly these words. */
export function SafeAnswers({ onAnswer }: { onAnswer(text: string): void }) {
  return (
    <div className="rd-safe-answers" data-testid="safe-answers">
      {CRISIS_TEXT.askSafe.map((word) => (
        <Button key={word} large outline onClick={() => onAnswer(word)}>
          {word}
        </Button>
      ))}
    </div>
  )
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

  useEffect(() => {
    function handler(event: Event) {
      const detail = (event as CustomEvent<SosPayload>).detail ?? {}
      setPayload(detail)
      setOpened(true)
      // Counted, not attributed: opening this sheet must not become a mark on the account.
      if (detail.source) trackAnonymous(AnalyticsEvent.SosOpened, { source: detail.source })
    }
    const close = () => setOpened(false)
    window.addEventListener(SOS_EVENT, handler)
    window.addEventListener(CLOSE_EVENT, close)
    return () => {
      window.removeEventListener(SOS_EVENT, handler)
      window.removeEventListener(CLOSE_EVENT, close)
    }
  }, [])
  useEffect(() => crisisStore.setSheetOpen(opened), [opened])
  const { ui } = useSyncExternalStore(crisisStore.subscribe, crisisStore.getSnapshot, crisisStore.getSnapshot)
  const variant = payload.variant

  const hotlines = payload.hotlines?.length ? payload.hotlines : HOTLINES

  return (
    <Sheet
      className="ph-no-capture"
      opened={opened}
      onSheetClosed={() => setOpened(false)}
      swipeToClose
      closeOnEscape
      backdrop
      style={{ height: 'auto' }}
    >
      <div className="rd-sheet-body">
        <h2 className="rd-sheet-title">{variant === 'help' ? CRISIS_TEXT.helpTitle : 'Если сейчас тяжело'}</h2>
        {variant === 'help' && (
          <>
            <CallButton hotline={CALL_NOW_HOTLINE} label={CRISIS_TEXT.callNow} testId="sos-call-now" />
            <a
              href={telHref('112')}
              data-testid="sos-call-112"
              className="rd-call-button rd-call-button--outline ph-no-capture"
              onClick={() => trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: 'Экстренные службы' })}
            >
              {CRISIS_TEXT.call112}
            </a>
            <button
              type="button"
              className="rd-safe-link"
              data-testid="sos-safe-link"
              onClick={() => {
                crisisStore.answer(CRISIS_TEXT.safeAnswer)
                setOpened(false)
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
            className="rd-call-button rd-call-button--big ph-no-capture"
            onClick={() => trackAnonymous(AnalyticsEvent.HotlineCalled, { hotline: 'Экстренные службы' })}
          >
            112
          </a>
        )}
        {ui.askSafe && variant !== 'call112' && <SafeAnswers onAnswer={crisisStore.answer} />}
        {!variant && (
          <p className="rd-muted">
            {payload.text ??
              'Позвони по одному из номеров — там ответит человек. Это бесплатно и круглосуточно.'}
          </p>
        )}
        {(variant ? OTHER_HOTLINES.filter((line) => variant === 'call112' || line !== CALL_NOW_HOTLINE) : hotlines).map((hotline) => (
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
        {/* An explicit button rather than tap-outside-to-close: this sheet opens at a hard moment,
            so the way out has to be visible. */}
        <Button large outline onClick={() => setOpened(false)}>
          Закрыть
        </Button>
      </div>
    </Sheet>
  )
}
