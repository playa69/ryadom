import { z } from 'zod'

/** True for a zone name the runtime knows (`Europe/Moscow`); a bare offset or a made-up name is not one. */
export function isKnownTimezone(name: string): boolean {
  // Newer runtimes accept an offset like `+03:00` as a zone; the diary wants a named zone that follows DST rules.
  if (name !== 'UTC' && !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(name)) return false
  if (name.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch {
    return false
  }
}

export const updateUserTimezoneSchema = z.object({
  timezone: z.string().refine(isKnownTimezone, 'Unknown IANA time zone'),
})
