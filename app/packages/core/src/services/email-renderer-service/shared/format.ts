const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Moscow',
})

/** Produces «24 сентября 2026 г. в 15:30 по Москве», independent of the server time zone. */
export function formatMoscowDateTime(date: Date): string {
  return `${dateTimeFormat.format(date)} по Москве`
}

export function greeting(userName: string | null): string {
  const name = userName?.trim()
  return name ? `Привет, ${name}!` : 'Привет!'
}
