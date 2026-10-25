import { visible } from '@ryadom/self-check/catalog'

/**
 * Dev stacks and staging show the tests that wait for the owner's sign-off (`status: 'review'`); production
 * shows only `ready` ones. Switch: `NEXT_PUBLIC_SELF_CHECK_PREVIEW=1` at build time.
 */
export const SELF_CHECK_PREVIEW = process.env.NEXT_PUBLIC_SELF_CHECK_PREVIEW === '1'

export const shownTests = () => visible(SELF_CHECK_PREVIEW)
