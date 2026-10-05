/*
 * A button that is waiting for an answer. The label stays so the button keeps its width, a spinner
 * comes in front of it, and the press is ignored by pointer-events rather than `disabled`, so keyboard
 * focus stays on it. Slower under prefers-reduced-motion, as the old global rule was.
 */
export const BUSY =
  "aria-busy:pointer-events-none aria-busy:before:size-[1em] aria-busy:before:shrink-0 aria-busy:before:animate-spin aria-busy:before:rounded-full aria-busy:before:border-2 aria-busy:before:border-current aria-busy:before:border-r-transparent aria-busy:before:content-[''] aria-busy:before:[animation-duration:0.7s] motion-reduce:aria-busy:before:[animation-duration:2s]"
