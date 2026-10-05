/** Time arithmetic without external libraries; time comes from Date, which tests fake. */
export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000)
}

export function addMinutes(date: Date, minutes: number): Date {
  return addSeconds(date, minutes * 60)
}

export function addHours(date: Date, hours: number): Date {
  return addSeconds(date, hours * 60 * 60)
}

export function addDays(date: Date, days: number): Date {
  return addSeconds(date, days * 24 * 60 * 60)
}
