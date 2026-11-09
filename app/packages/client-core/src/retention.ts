import { ANONYMOUS_RETENTION_DAYS, DIALOG_RETENTION_DAYS } from '@ryadom/contracts/api/policy'
import { plural } from './diary'

/**
 * What the screens say about how long things are kept. The conversation copy follows the published policy;
 * the agent's actual cleanup schedule is configured separately. An account without a confirmed address is
 * erased after `ANONYMOUS_RETENTION_DAYS` without a visit, with everything in it. An address saves the
 * account, not the conversations.
 */

const days = (n: number): string => `${n} ${plural(n, 'день', 'дня', 'дней')}`

/** «Разговоры хранятся 30 дней после последнего сообщения.» */
export const DIALOG_KEEP_NOTE = `Разговоры хранятся ${days(DIALOG_RETENTION_DAYS)} после последнего сообщения.`

/** The end of «Без почты аккаунт …»: «удаляется через 90 дней без визитов». */
export const GUEST_LIFE_CLAUSE = `удаляется через ${days(ANONYMOUS_RETENTION_DAYS)} без визитов`
