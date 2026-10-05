/*
 * The product's keyboard focus ring: a gap in the page color, then a light-blue ring, so it reads on any
 * surface (the shared components' 50% blue halo does not). The transparent outline is what a
 * forced-colors mode (Windows High Contrast) paints in a system color: it drops box-shadow rings.
 */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-transparent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-paper'

/** What the shared Button does not bring for this app: the focus ring above and a pointer cursor. */
export const BUTTON = `${FOCUS_RING} cursor-pointer disabled:cursor-default`

/** The reading column of the conversation: feed, voice view and input box share it. A notch on the side of a phone on its side is cleared. */
export const COLUMN =
  'mx-auto w-full max-w-3xl pr-[max(1rem,env(safe-area-inset-right,0px))] pl-[max(1rem,env(safe-area-inset-left,0px))] tab:px-6'
