'use client'

import { useEffect, useState } from 'react'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import type { MicGuide } from '@ryadom/client-core/voice/mic-guide'
import { queryMicPermission, watchMicPermission } from '@ryadom/client-core/voice/mic-permission'
import Modal from './Modal'
import { BUTTON } from './controls'

/** After a refused microphone: how to turn it back on for this place, then try again or write instead. */
export default function MicGuideSheet({
  guide,
  again,
  onRetry,
  onText,
}: {
  guide: MicGuide | null
  /** A retry was refused as well. */
  again: boolean
  onRetry(): void
  onText(): void
}) {
  const [copied, setCopied] = useState(false)
  const open = guide !== null

  // The person goes to the settings and comes back: the browser says so by itself where it can, and on the
  // way back to the page it is asked once more. A switch found on goes straight to the conversation.
  useEffect(() => {
    if (!open) return
    const stop = watchMicPermission((state) => state === 'granted' && onRetry())
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void queryMicPermission().then((state) => state === 'granted' && onRetry())
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [open, onRetry])

  return (
    <Modal open={guide !== null} onClose={onText} title={guide?.title ?? ''}>
      {again && (
        <p className="text-base leading-[1.55] text-destructive" data-testid="mic-guide-again" role="status">
          Микрофон по-прежнему выключен.
        </p>
      )}
      <p className="text-base leading-[1.55] text-dim" data-testid="mic-guide-intro">
        {guide?.intro}
      </p>
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0" data-testid="mic-guide-steps">
        {guide?.steps.map((step, index) => (
          <li key={step} className="flex items-start gap-3 text-base leading-[1.45]">
            <span
              aria-hidden
              className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-white/15 text-sm"
            >
              {index + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-3 tab:flex-row-reverse tab:flex-wrap tab:justify-start">
        <Button
          type="button"
          className={cn(BUTTON, 'w-full bg-clip-border focus-visible:border-transparent tab:w-auto tab:min-w-44 tab:flex-none')}
          onClick={onRetry}
          data-testid="mic-guide-retry"
        >
          Попробовать снова
        </Button>
        {guide?.copyAddress && (
          <Button
            type="button"
            variant="outline"
            className={cn(BUTTON, 'w-full border-input! tab:w-auto')}
            onClick={() => {
              void navigator.clipboard?.writeText(window.location.origin).then(() => setCopied(true))
            }}
            data-testid="mic-guide-copy"
          >
            {copied ? 'Адрес скопирован' : 'Скопировать адрес'}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          className={cn(BUTTON, 'w-full border-input! tab:w-auto')}
          onClick={onText}
          data-testid="mic-guide-text"
        >
          Писать текстом
        </Button>
      </div>
    </Modal>
  )
}
