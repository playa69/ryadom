import { savedLine, toneOfResult, type SavedResult } from '@ryadom/self-check/history'
import type { SelfCheckTest } from '@ryadom/self-check/types'
import { TONE_COLOR, lengthLine } from './format'

/** The second line of a row: the last saved result with the dot of its level, or the length line of the test. */
export default function SavedLine({ test, result }: { test: SelfCheckTest; result?: SavedResult }) {
  if (!result) return <>{lengthLine(test)}</>
  return (
    <span data-testid={`saved-line-${test.id}`}>
      <i
        aria-hidden="true"
        className="rd-dot"
        style={{ background: TONE_COLOR[toneOfResult(test, result)] }}
      />
      {savedLine(test, result)}
    </span>
  )
}
