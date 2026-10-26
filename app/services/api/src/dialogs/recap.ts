import {
  RECAP_ABOUT_MAX,
  RECAP_AGREEMENT_MAX,
  RECAP_AGREEMENTS_MAX,
  RECAP_MAIN_MAX,
  type DialogRecapApi,
} from '@ryadom/contracts/api/dialogs'

/**
 * The recap in an `end` frame, as the person wrote it: three texts, the last one a list of up to three short items.
 * Anything else is dropped (the agent writes the recap itself then), never repaired: the text is the person's own.
 */
export function parseRecap(value: unknown): DialogRecapApi | null {
  if (typeof value !== 'object' || value === null) return null
  const { about, main, agreements } = value as { about?: unknown; main?: unknown; agreements?: unknown }
  if (typeof about !== 'string' || typeof main !== 'string') return null
  const items = Array.isArray(agreements) ? agreements : []
  if (
    about.trim() === '' ||
    main.trim() === '' ||
    about.length > RECAP_ABOUT_MAX ||
    main.length > RECAP_MAIN_MAX ||
    items.length > RECAP_AGREEMENTS_MAX ||
    items.some((item) => typeof item !== 'string' || item.length > RECAP_AGREEMENT_MAX)
  ) {
    return null
  }
  return { about, main, agreements: items as string[] }
}
