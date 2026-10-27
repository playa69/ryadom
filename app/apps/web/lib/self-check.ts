import { visible, wave1 } from '@ryadom/self-check/catalog'

/**
 * Dev stacks and staging also show the tests that wait for the owner's sign-off (`status: 'review'`); production
 * shows only `ready` ones. Switch: `NEXT_PUBLIC_SELF_CHECK_PREVIEW=1` at build time.
 */
export const SELF_CHECK_PREVIEW = process.env.NEXT_PUBLIC_SELF_CHECK_PREVIEW === '1'

/** Every test to show. */
export const shownTests = () => visible(SELF_CHECK_PREVIEW)

/** The six scales of the diary block (wave 1). */
export const shownWave1 = () => visible(SELF_CHECK_PREVIEW, wave1)
