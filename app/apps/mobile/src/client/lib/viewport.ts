import { useEffect, useState } from 'react'

/**
 * Wide-screen breakpoints (desktop browser, tablet). They match the @media rules in
 * styles/app.css and change only together with them.
 *
 * - DESKTOP: the bottom tabs become a rail on the left, content is one column of the same width
 *   for every section, sheets and toasts are centered at one width;
 * - WIDE: two panes where there is something to split (the journal list and an entry side by
 *   side, the home screen in two columns).
 *
 * Below DESKTOP it is the phone layout — the same as in the store builds.
 */
export const DESKTOP_QUERY = '(min-width: 700px)'
export const WIDE_QUERY = '(min-width: 1024px)'

/** A short phone screen: the home circle shrinks so that the first screen holds the actions too. */
export const SHORT_QUERY = '(max-height: 880px)'

/** A mouse (and usually a keyboard): a computer rather than a tablet — hover, thin scrollbars. */
export const MOUSE_QUERY = '(hover: hover) and (pointer: fine)'

export function matchesQuery(query: string): boolean {
  return window.matchMedia(query).matches
}

/** Whether the media query matches right now; re-renders on change (resize, rotation). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesQuery(query))
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}
