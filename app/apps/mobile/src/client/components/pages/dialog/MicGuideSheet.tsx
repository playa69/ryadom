import { Button, Sheet } from 'framework7-react'
import { useEffect, useRef, useState } from 'react'
import type { MicGuide } from '@ryadom/client-core/voice/mic-guide'
import { queryMicPermission, watchMicPermission } from '@ryadom/client-core/voice/mic-permission'

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
  onRetry: () => void
  onText: () => void
}) {
  const [copied, setCopied] = useState(false)
  const opened = guide !== null
  // The sheet also reports closing when the screen closes it (a retry, a choice); only a swipe or a tap on the backdrop is a decision to write.
  const stillOpen = useRef(opened)
  stillOpen.current = opened

  // The person goes to the settings and comes back: the browser says so by itself where it can, and on the
  // way back to the page it is asked once more.
  useEffect(() => {
    if (!opened) return
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
  }, [opened, onRetry])

  return (
    <Sheet opened={opened} onSheetClosed={() => stillOpen.current && onText()} swipeToClose closeOnEscape backdrop style={{ height: 'auto' }}>
      <div className="rd-sheet-body rd-sheet-body--scroll" data-testid="mic-guide">
        <h2 className="rd-sheet-title">{guide?.title}</h2>
        {again && (
          <p className="rd-form-error" role="status" data-testid="mic-guide-again">
            Микрофон по-прежнему выключен.
          </p>
        )}
        <p className="rd-muted" data-testid="mic-guide-intro">
          {guide?.intro}
        </p>
        <ol className="rd-mic-steps" data-testid="mic-guide-steps">
          {guide?.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {guide?.copyAddress && (
          <Button
            large
            onClick={() => {
              void navigator.clipboard?.writeText(window.location.origin).then(() => setCopied(true))
            }}
            data-testid="mic-guide-copy"
          >
            {copied ? 'Адрес скопирован' : 'Скопировать адрес'}
          </Button>
        )}
        <Button fill large onClick={onRetry} data-testid="mic-guide-retry">
          Попробовать снова
        </Button>
        <Button large onClick={onText} data-testid="mic-guide-text">
          Писать текстом
        </Button>
      </div>
    </Sheet>
  )
}
