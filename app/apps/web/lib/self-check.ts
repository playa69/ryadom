import { visible, wave1 } from '@ryadom/self-check/catalog'

/** Every test to show: the ones the owner has signed off (`status: 'ready'`), in every build. */
export const shownTests = () => visible()

/** The six scales of the diary block (wave 1). */
export const shownWave1 = () => visible(wave1)
