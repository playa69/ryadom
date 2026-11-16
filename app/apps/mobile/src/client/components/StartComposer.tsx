import { Button } from 'framework7-react'
import type { ChangeEvent, KeyboardEvent } from 'react'
import { DIALOG_START_SUGGESTIONS } from '@ryadom/client-core/dialog-start'
import { InputLimit } from '@ryadom/contracts/api/limits'

/**
 * Enter submits the draft and Shift+Enter inserts a newline, as in any messenger. A structural type
 * keeps the helper usable outside the DOM (unit tests).
 */
export function isSubmitKey(event: { key: string; shiftKey: boolean }): boolean {
  return event.key === 'Enter' && !event.shiftKey
}

/**
 * Where the Arrow/Home/End keys take the suggestion strip: the arrows step by a viewport, Home goes
 * to its start and End to its end (scrollWidth; scrollTo clamps it to the last reachable offset).
 * Other keys, Tab among them, scroll nothing and keep their native behavior.
 */
export function chipsScrollTarget(
  key: string,
  scrollLeft: number,
  viewport: number,
  scrollWidth: number,
): number | null {
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, scrollLeft - viewport)
    case 'ArrowRight':
      return scrollLeft + viewport
    case 'Home':
      return 0
    case 'End':
      return scrollWidth
    default:
      return null
  }
}

/**
 * The first-message field of the PWA/Telegram start screens: the same suggestions as on the web and a
 * controlled draft owned by the page. A suggestion only fills the field in — no account, conversation
 * or request is made until the page's own start button (or Enter here). The native shell keeps the
 * voice-only start, so the pages render this composer only outside it (`!isNative()`).
 *
 * The suggestions are one horizontally scrollable strip of content-wide chips, not three wrapped
 * rows: the strip scrolls instead of pushing the field down, and it is focusable so a keyboard
 * scrolls it too.
 */
export default function StartComposer({
  draft,
  disabled,
  onDraftChange,
  onSubmit,
}: {
  draft: string
  disabled?: boolean
  onDraftChange: (draft: string) => void
  onSubmit: () => void
}) {
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!isSubmitKey(event)) return
    event.preventDefault()
    onSubmit()
  }

  // The strip scrolls by keyboard on its own: horizontal arrows do nothing natively on a focused
  // div, and Home/End would scroll the page instead. Tab is left alone so focus moves out of it.
  function onChipsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const strip = event.currentTarget
    const target = chipsScrollTarget(event.key, strip.scrollLeft, strip.clientWidth, strip.scrollWidth)
    if (target === null) return
    event.preventDefault()
    strip.scrollTo({ left: target })
  }

  return (
    <div className="rd-start-composer" data-testid="start-composer">
      <div
        className="rd-start-suggestions"
        role="group"
        aria-label="Подсказки первого сообщения"
        tabIndex={0}
        onKeyDown={onChipsKeyDown}
      >
        {DIALOG_START_SUGGESTIONS.map((suggestion) => (
          <Button
            key={suggestion}
            small
            outline
            round
            type="button"
            disabled={disabled}
            onClick={() => onDraftChange(suggestion)}
            data-testid="start-suggestion"
          >
            {suggestion}
          </Button>
        ))}
      </div>
      {/* The pill styling of the dialog's own composer: the same field, one screen earlier. */}
      <div className="rd-dialog-bar rd-start-field">
        <textarea
          placeholder="Напиши, что происходит…"
          value={draft}
          maxLength={InputLimit.MessageMax}
          rows={1}
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          data-testid="start-draft"
        />
      </div>
    </div>
  )
}
