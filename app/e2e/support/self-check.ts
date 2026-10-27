import { visible, wave1 } from '@ryadom/self-check/catalog'

/** The tests the web client shows: those with the owner's sign-off (`status: 'ready'`), the same data the stack is built from. */
const shown = new Set(visible().map((t) => t.id))

/** Whether the diary has the block «Самопроверка» and the segment «Тесты»: only once some test is ready. */
export const HAS_SHOWN_TESTS = shown.size > 0

/** The walk-through of `web-self-check` goes over all six scales of wave 1, so it runs when all of them are ready. */
export const WAVE1_SHOWN = wave1.every((t) => shown.has(t.id))
