import { visible, wave1 } from '@ryadom/self-check/catalog'

/**
 * Tests inside the app are switched as a whole (`SELF_CHECK_ENABLED`, add-self-check-tests D9): off, the diary
 * has neither the block «Самопроверка» nor the segment «Тесты». The web app reads it at build time
 * (`NEXT_PUBLIC_SELF_CHECK_ENABLED=1`); the server has its own `SELF_CHECK_ENABLED`.
 */
export const SELF_CHECK_ENABLED = process.env.NEXT_PUBLIC_SELF_CHECK_ENABLED === '1'

/**
 * Dev stacks and staging also show the tests that wait for the owner's sign-off (`status: 'review'`); production
 * shows only `ready` ones. Switch: `NEXT_PUBLIC_SELF_CHECK_PREVIEW=1` at build time.
 */
const SELF_CHECK_PREVIEW = process.env.NEXT_PUBLIC_SELF_CHECK_PREVIEW === '1'

/** Every test to show: nothing while the tests are off. */
export const shownTests = () => (SELF_CHECK_ENABLED ? visible(SELF_CHECK_PREVIEW) : [])

/** The six scales of the diary block (wave 1). */
export const shownWave1 = () => (SELF_CHECK_ENABLED ? visible(SELF_CHECK_PREVIEW, wave1) : [])
