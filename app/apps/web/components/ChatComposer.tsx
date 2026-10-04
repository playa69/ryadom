'use client'

import { ArrowUp, MessageCircle, Mic } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { Button } from '@ryadom/ui/components/button'
import { Spinner } from '@ryadom/ui/components/spinner'
import { Textarea } from '@ryadom/ui/components/textarea'
import { cn } from '@ryadom/ui/lib/utils'
import { BUTTON } from './controls'

const FIELD_MAX_HEIGHT_PX = 200

export interface ChatComposerProps {
  /** `hero` is the big box in the middle of the home page; `dock` is the one pinned under a conversation. */
  variant: 'hero' | 'dock'
  /** Prefix of the data-testid values: `home-input`, `dialog-mic`, ... */
  testIdPrefix: 'home' | 'dialog'
  placeholder: string
  /** Actions can go out now. Until then the draft just stays in the field (the socket is still connecting). */
  ready?: boolean
  /** The request that follows a send is in flight: further presses are ignored, the button says so. */
  busy?: boolean
  /** With an empty field the send button still works, under this name (home: "Поговорить"). */
  emptyLabel?: string
  /** Keep the text after a send. Home needs it: the start can fail and the person tries again. */
  keepDraft?: boolean
  /** Put the cursor in the field on arrival, but only where there is no on-screen keyboard to pop up. */
  autoFocus?: boolean
  onSubmit(text: string): void
  /** The microphone was pressed. It gets the draft: home starts a conversation that carries it along. */
  onMic(draft: string): void
}

/**
 * The input box of a chat app: a growing textarea with the microphone and the send button inside
 * it. Home and the conversation share it; props decide the size and what an empty send means. The
 * draft lives here, so typing does not re-render the feed above.
 *
 * Under a conversation the box is the text face of a voice-first screen: with nothing typed its one
 * button is the sphere that goes back to the voice, and once there are words it becomes "send".
 */
export default function ChatComposer({
  variant,
  testIdPrefix,
  placeholder,
  ready = true,
  busy = false,
  emptyLabel,
  keepDraft = false,
  autoFocus = false,
  onSubmit,
  onMic,
}: ChatComposerProps) {
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const hero = variant === 'hero'

  // Grows with the text up to a cap. Set through CSSOM: the CSP forbids inline style attributes.
  const fit = useCallback(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, FIELD_MAX_HEIGHT_PX)}px`
  }, [])

  useLayoutEffect(() => {
    fit()
  }, [draft, fit])

  // The text re-wraps when the field's width changes (a window resizes, the sidebar folds), and a
  // height measured at the old width would stay wrong.
  useEffect(() => {
    const el = field.current
    if (!el) return
    let width = -1
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      // Outside the callback: changing the observed height in here would make the observer loop.
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [fit])

  useEffect(() => {
    if (autoFocus && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      field.current?.focus({ preventScroll: true })
    }
  }, [autoFocus])

  const text = draft.trim()
  const canSend = ready && !busy && (text.length > 0 || emptyLabel !== undefined)
  const sendLabel = text ? 'Отправить' : (emptyLabel ?? 'Отправить')

  function submit() {
    if (!canSend) return
    onSubmit(text)
    if (!keepDraft) setDraft('')
    // Keep the keyboard open after tapping the send button, as a messenger does.
    if (!hero) field.current?.focus()
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    submit()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends and Shift+Enter inserts a newline. Enter that confirms an IME candidate is not a send,
    // and Enter in an empty field is never a send: starting without words is the button's job.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (text) submit()
    }
  }

  return (
    // The box is the field's boundary, so it carries the product focus ring, as the other fields do. The
    // transparent outline is what forced-colors modes paint instead of the ring.
    <form
      className={cn(
        'glass-2 flex w-full items-end gap-1 border-input p-2 transition-colors',
        'focus-within:border-ring focus-within:shadow-focus focus-within:outline-2 focus-within:outline-solid focus-within:outline-transparent',
        hero ? 'rounded-2xl p-2.5 shadow-float' : 'rounded-xl shadow-card',
      )}
      onSubmit={handleSubmit}
    >
      <Textarea
        ref={field}
        // The box carries the border, the background, the focus edge and the forced-colors outline; the field
        // itself is bare. `outline-none` also drops the shared field's transparent outline, which forced
        // colors would paint as a square inside the rounded box.
        className={cn(
          'max-h-50 min-h-11 w-auto min-w-0 flex-1 field-sizing-fixed resize-none rounded-none border-0 bg-transparent px-3 py-2.5 leading-normal text-balance shadow-none outline-none placeholder:text-dim focus-visible:border-transparent focus-visible:shadow-none',
          hero && 'tab:px-4 tab:text-lg',
        )}
        name="message"
        aria-label="Сообщение"
        placeholder={placeholder}
        value={draft}
        maxLength={InputLimit.MessageMax}
        rows={hero ? 2 : 1}
        enterKeyHint="send"
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        data-testid={`${testIdPrefix}-input`}
      />
      {!hero && !text ? (
        // The voice is the main way to talk: with an empty box the only button is the way back to it.
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(BUTTON, 'orb-chip border-transparent text-white outline-none hover:text-white focus-visible:text-white')}
          aria-label="Говорить голосом"
          disabled={!ready || busy}
          onClick={() => onMic(text)}
          data-testid={`${testIdPrefix}-mic`}
        >
          <Mic className="size-5" aria-hidden="true" />
        </Button>
      ) : (
        <>
          {hero && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(BUTTON, 'outline-none text-dim hover:text-foreground focus-visible:text-foreground')}
              aria-label="Говорить"
              disabled={!ready || busy}
              onClick={() => onMic(text)}
              data-testid={`${testIdPrefix}-mic`}
            >
              <Mic className="size-5" aria-hidden="true" />
            </Button>
          )}
          <Button
            type="submit"
            size="icon"
            // Just the glow, not the large CTA's top highlight: on a 44px circle that would read as a rim.
            className={cn(
              BUTTON,
              'border-transparent bg-clip-border outline-none shadow-(--ryadom-cta-glow) hover:brightness-112 focus-visible:border-transparent',
              // Nothing to send yet: a quiet disc instead of a washed-out blue one.
              'disabled:bg-accent disabled:bg-none disabled:text-faint disabled:opacity-100 disabled:shadow-none',
              // Pointer-events off while waiting rather than `disabled`, so keyboard focus stays on the button.
              'aria-busy:pointer-events-none',
              // From the sidebar's breakpoint up there is room for the word. Both words get the same width, so
              // the microphone beside it does not slide when the first letter is typed.
              emptyLabel && 'tab:w-40 tab:gap-2',
            )}
            aria-label={sendLabel}
            aria-busy={busy}
            disabled={!canSend && !busy}
            data-testid={`${testIdPrefix}-${emptyLabel === undefined ? 'send' : 'talk'}`}
          >
            {busy ? (
              <Spinner
                role={undefined}
                aria-label={undefined}
                aria-hidden="true"
                className="size-5 motion-reduce:[animation-duration:2s]"
              />
            ) : text || emptyLabel === undefined ? (
              <ArrowUp className="size-5" aria-hidden="true" />
            ) : (
              // An empty field with a way to start: the button begins a conversation, it does not send anything.
              <MessageCircle className="size-5" aria-hidden="true" />
            )}
            {emptyLabel && (
              <span className="hidden tab:inline" aria-hidden="true">
                {sendLabel}
              </span>
            )}
          </Button>
        </>
      )}
    </form>
  )
}
