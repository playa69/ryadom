import type { HotlineApiResponse } from '@ryadom/contracts/api/dialogs'

/**
 * Hotlines the server substitutes into the `safety` frame when the agent supplied none:
 * the hotlines are always one tap away.
 *
 * The client carries exactly the same built-in list and shows it even with no network. The two
 * lists must match, otherwise a person sees different numbers depending on whether the frame from
 * the server arrived. The list must be reviewed by counsellors before release:
 * this is a safeguard that fires at the worst possible moment.
 */
export const HOTLINES: HotlineApiResponse[] = [
  { name: 'Экстренные службы', phone: '112' },
  { name: 'Психологическая помощь МЧС России', phone: '8 (495) 989-50-50' },
  { name: 'Московская служба психологической помощи', phone: '8 (495) 575-03-16' },
]
