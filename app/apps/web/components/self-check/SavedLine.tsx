import type { SavedResult } from '@ryadom/self-check/history'
import { savedLine, toneOfResult } from '@ryadom/self-check/history'
import type { SelfCheckTest } from '@ryadom/self-check/types'
import { TONE_COLOR, lengthLine } from './ui'

/** The second line of a row: the last saved result with the dot of its level, or the length line of the test. */
export default function SavedLine({ test, result }: { test: SelfCheckTest; result?: SavedResult }) {
  if (!result) return <span>{lengthLine(test)}</span>
  return (
    <span data-testid={`saved-line-${test.id}`}>
      <i
        aria-hidden="true"
        className="mr-1.5 inline-block size-2 rounded-full"
        style={{ background: TONE_COLOR[toneOfResult(test, result)] }}
      />
      {savedLine(test, result)}
    </span>
  )
}
