'use client'

import { DIALOG_START_SUGGESTIONS } from '@ryadom/client-core/dialog-start'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { BUTTON } from './controls'

/**
 * The start suggestions above the home input box. A pick only fills the draft — no account, no
 * dialog, no request; sending stays the person's own action. The texts are shared with the mobile
 * client through `@ryadom/client-core`, so both surfaces offer the same starts.
 */
export default function DialogStartSuggestions({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex max-w-xl flex-wrap items-center justify-center gap-2" data-testid="home-suggestions">
      {DIALOG_START_SUGGESTIONS.map((suggestion, index) => (
        <Button
          key={suggestion}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPick(suggestion)}
          data-testid={`home-suggestion-${index + 1}`}
          className={cn(
            BUTTON,
            'outline-none',
            'border-input! px-3.5 text-sm text-dim enabled:hover:text-foreground',
          )}
        >
          {suggestion}
        </Button>
      ))}
    </div>
  )
}
