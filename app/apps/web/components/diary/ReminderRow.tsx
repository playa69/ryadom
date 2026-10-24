'use client'

import { useState } from 'react'
import type { DiaryApiResponse } from '@ryadom/contracts/api/diary'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { useClient } from '@/lib/auth'
import { REMINDER_TIMES } from '@/lib/diary'
import { enablePush, pushPermission, pushSupport } from '@/lib/notifications'
import { BUTTON } from '../controls'

type Reminder = DiaryApiResponse['reminder']

/**
 * The reminder under the mood card (`REQ-WELL-02`). Until the person answers "Напоминать вечером?",
 * only that question is shown; the browser's own permission prompt appears after "Да" and never
 * before. Then a switch with the time (08:00–22:30 by half hours); paused reminders offer "Вернуть".
 */
export default function ReminderRow({ reminder, onChange }: { reminder: Reminder; onChange(next: Reminder): void }) {
  const client = useClient()
  const [busy, setBusy] = useState(false)
  const [denied, setDenied] = useState(() => pushPermission() === 'denied')
  const [note, setNote] = useState<string | null>(null)
  const support = pushSupport()

  async function update(patch: Parameters<typeof client.updateNotificationSettings>[0]) {
    setBusy(true)
    try {
      const settings = await client.updateNotificationSettings(patch)
      onChange({
        enabled: settings.moodReminder.enabled,
        time: settings.moodReminder.time,
        paused: settings.moodReminder.paused,
        offerAnswered: settings.offerAnswered,
      })
      return settings
    } catch {
      setNote('Не получилось сохранить настройку. Попробуй ещё раз')
      return null
    } finally {
      setBusy(false)
    }
  }

  async function accept() {
    const settings = await update({ offerAnswered: true, moodReminder: { enabled: true } })
    if (!settings) return
    const outcome = await enablePush(client, settings.vapidPublicKey)
    if (outcome === 'denied') setDenied(true)
    if (outcome === 'unavailable') setNote('Не получилось подключить уведомления на этом устройстве')
  }

  if (!reminder.offerAnswered) {
    return (
      <div className="flex flex-col gap-3 border-t border-line pt-4" data-testid="diary-reminder-offer">
        <p className="text-[0.9375rem] font-medium text-foreground">Напоминать вечером, в {reminder.time}?</p>
        <div className="flex gap-2">
          <Button size="sm" className={BUTTON} disabled={busy} data-testid="diary-reminder-yes" onClick={() => void accept()}>
            Да
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={BUTTON}
            disabled={busy}
            data-testid="diary-reminder-no"
            onClick={() => void update({ offerAnswered: true, moodReminder: { enabled: false } })}
          >
            Не нужно
          </Button>
        </div>
        {note && <p className="text-sm text-danger">{note}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2.5 border-t border-line pt-4" data-testid="diary-reminder">
      <div className="flex items-center gap-3">
        <span id="diary-reminder-label" className="min-w-0 flex-1 text-[0.9375rem] font-medium text-foreground">
          Напоминать о настроении
        </span>
        <select
          aria-label="Время напоминания"
          data-testid="diary-reminder-time"
          value={reminder.time}
          disabled={busy || !reminder.enabled}
          onChange={(e) => void update({ moodReminder: { time: e.target.value } })}
          className={cn(BUTTON, 'h-9 rounded-md border border-line bg-transparent px-2 text-sm text-dim disabled:opacity-50')}
        >
          {(REMINDER_TIMES.includes(reminder.time) ? REMINDER_TIMES : [reminder.time, ...REMINDER_TIMES]).map((t) => (
            <option key={t} value={t} className="bg-paper text-foreground">
              {t}
            </option>
          ))}
        </select>
        <button
          type="button"
          role="switch"
          aria-checked={reminder.enabled}
          aria-labelledby="diary-reminder-label"
          data-testid="diary-reminder-switch"
          disabled={busy}
          onClick={() => void update({ moodReminder: { enabled: !reminder.enabled } })}
          className={cn(
            BUTTON,
            'relative h-7 w-12 shrink-0 rounded-full transition-colors',
            reminder.enabled ? 'bg-brand' : 'bg-white/20',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 left-0.5 size-6 rounded-full bg-white transition-transform',
              reminder.enabled && 'translate-x-5',
            )}
          />
        </button>
      </div>
      {reminder.enabled && reminder.paused && (
        <div className="flex items-center gap-3" data-testid="diary-reminder-paused">
          <p className="min-w-0 flex-1 text-sm text-dim">Напоминания на паузе — вернуть?</p>
          <Button size="sm" variant="outline" className={BUTTON} disabled={busy} onClick={() => void update({ moodReminder: { enabled: true } })}>
            Вернуть
          </Button>
        </div>
      )}
      {reminder.enabled && support === 'needs-install' && (
        <p className="text-sm text-dim">Напоминания работают, если добавить Рядом на экран «Домой»</p>
      )}
      {reminder.enabled && denied && (
        <p className="text-sm text-dim" data-testid="diary-reminder-denied">
          Уведомления запрещены в настройках. Разреши их для этого сайта в настройках браузера (значок замка рядом с адресом).
        </p>
      )}
      {note && <p className="text-sm text-danger">{note}</p>}
    </div>
  )
}
