import { Button, Icon, Sheet } from 'framework7-react'
import { useEffect, useState } from 'react'
import type { HotlineApiResponse } from '@ryadom/contracts/api/dialogs'
import { HOTLINES, telHref } from '../lib/hotlines'

/**
 * Help lines (SOS is reachable from any screen, and the lines are one tap away).
 *
 * Opened by the SOS button and by a `safety` frame from the dialog. The default list is bundled
 * into the app and works with no network; when the agent sends its own list, that one is shown.
 */

export const SOS_EVENT = 'ryadom:sos'

export interface SosPayload {
  text?: string | null
  hotlines?: HotlineApiResponse[]
}

/** Open the help sheet from anywhere: the SOS button or a safety frame. */
export function openSos(payload: SosPayload = {}): void {
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
export function SosButton({ slot }: { slot?: string }) {
  return (
    <button type="button" className="rd-sos-button" slot={slot} onClick={() => openSos()}>
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
      setPayload((event as CustomEvent<SosPayload>).detail ?? {})
      setOpened(true)
    }
    window.addEventListener(SOS_EVENT, handler)
    return () => window.removeEventListener(SOS_EVENT, handler)
  }, [])

  const hotlines = payload.hotlines?.length ? payload.hotlines : HOTLINES

  return (
    <Sheet
      opened={opened}
      onSheetClosed={() => setOpened(false)}
      swipeToClose
      closeOnEscape
      backdrop
      style={{ height: 'auto' }}
    >
      <div className="rd-sheet-body">
        <h2 className="rd-sheet-title">Если сейчас тяжело</h2>
        <p className="rd-muted">
          {payload.text ??
            'Позвони по одному из номеров — там ответит человек. Это бесплатно и круглосуточно.'}
        </p>
        {hotlines.map((hotline) => (
          <a key={hotline.phone} className="rd-hotline" href={telHref(hotline.phone)}>
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
