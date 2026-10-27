import { track } from '@ryadom/analytics/browser'

/**
 * `track` for the events of a conversation screen: a conversation held unsaved ("Не сохранять этот разговор") reports none of them.
 * Whether it is unsaved is read when an event is sent, not when the screen is drawn: the answer can arrive after the first render.
 */
export function trackUnlessUnsaved(isUnsaved: () => boolean): typeof track {
  return ((event: unknown, ...args: unknown[]) => {
    if (isUnsaved()) return
    ;(track as (event: unknown, ...args: unknown[]) => void)(event, ...args)
  }) as typeof track
}
