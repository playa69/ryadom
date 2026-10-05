import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Closer to the end than this counts as "still reading the latest message". */
const NEAR_END_PX = 96

function distanceFromEnd(): number {
  const root = document.documentElement
  return root.scrollHeight - (window.scrollY + window.innerHeight)
}

function scrollToEnd(smooth: boolean): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  window.scrollTo({
    top: document.documentElement.scrollHeight,
    behavior: smooth && !reduced ? 'smooth' : 'auto',
  })
}

/**
 * Keeps a growing chat pinned to its end without fighting the reader. The page itself scrolls (the
 * composer is sticky), so this watches the window: while the person sits near the end, new text
 * carries them along; once they scroll up to reread, the feed stays put and `hasNew` offers a way
 * back instead of yanking them down mid-sentence.
 *
 * `version` is anything that changes when the feed changes. `dock` is the sticky input box: it grows
 * with a long draft and covers the end of the page, so while the person is pinned its growth moves
 * the end into view just as a new message does.
 */
export function useStickToEnd(
  version: unknown,
  dock?: RefObject<HTMLElement | null>,
): { hasNew: boolean; follow(): void; jumpToEnd(): void } {
  // Judged on scroll events only: content growing under a reader must not flip it.
  const pinned = useRef(true)
  const [hasNew, setHasNew] = useState(false)

  useEffect(() => {
    function onScroll() {
      pinned.current = distanceFromEnd() <= NEAR_END_PX
      if (pinned.current) setHasNew(false)
    }
    // The mobile keyboard resizes the viewport; keep the last line visible above it.
    function onResize() {
      if (pinned.current) scrollToEnd(false)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  // Resizing the dock does not scroll anything by itself, so no scroll event follows it either.
  useEffect(() => {
    const el = dock?.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (pinned.current) scrollToEnd(false)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [dock])

  useLayoutEffect(() => {
    if (pinned.current) scrollToEnd(false)
    else setHasNew(true)
  }, [version])

  /** The person's own message always brings the end into view. */
  const follow = useCallback(() => {
    pinned.current = true
  }, [])

  const jumpToEnd = useCallback(() => {
    pinned.current = true
    setHasNew(false)
    scrollToEnd(true)
  }, [])

  return { hasNew, follow, jumpToEnd }
}
