import { Button } from 'framework7-react'
import { useEffect, useState } from 'react'
import type { DiaryReminderApi } from '@ryadom/contracts/api/diary'
import { MOOD_REMINDER_DEFAULT_TIME } from '@ryadom/contracts/api/notifications'
import { apiErrorText, updateNotificationSettings } from '../../../lib/api'
import {
  deviceIsSubscribed,
  enableReminderOnDevice,
  notificationsBlocked,
  reminderChannel,
  type EnableResult,
} from '../../../lib/notifications'
import { isStandalone, isWebBuild } from '../../../lib/platform'
import { isTelegramMiniApp } from '../../../lib/telegram'
import Switch from '../../Switch'

/**
 * The reminder under the mood card (`REQ-WELL-04`): the first-time question, then a row with a switch and
 * the time. The system permission is asked for only after «Да» (never at launch), a refusal there leaves the
 * setting on the server as it was, and seven unopened reminders pause it until «Вернуть».
 */

/** 08:00 … 22:30 in half-hours. */
export const REMINDER_TIMES: string[] = Array.from({ length: 30 }, (_, i) => {
  const minutes = 8 * 60 + i * 30
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})

export default function ReminderBlock({ reminder }: { reminder: DiaryReminderApi }) {
  const [state, setState] = useState(reminder)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [blocked, setBlocked] = useState(notificationsBlocked())
  const channel = reminderChannel()

  // Another device or the server's pause changed it: the diary read is the newer word.
  useEffect(() => setState(reminder), [reminder])

  if (channel === 'none') return null
  if (channel === 'iphone-install') {
    return (
      <p className="rd-caption rd-reminder-hint" data-testid="diary-reminder-iphone">
        Напоминания работают, если добавить Рядом на экран «Домой»
      </p>
    )
  }

  async function save(change: Parameters<typeof updateNotificationSettings>[0]) {
    setBusy(true)
    setError('')
    try {
      const next = await updateNotificationSettings(change)
      setState({
        enabled: next.moodReminder.enabled,
        time: next.moodReminder.time,
        paused: next.moodReminder.paused,
        offerAnswered: next.offerAnswered,
      })
    } catch (e) {
      setError(apiErrorText(e, {}, 'Не получилось сохранить'))
    } finally {
      setBusy(false)
    }
  }

  /** Connects this device; the answer is told in words, never by a silent switch. */
  async function connect(): Promise<EnableResult> {
    const result = await enableReminderOnDevice()
    setBlocked(result === 'denied' && channel === 'web_push')
    if (result === 'denied') setError(channel === 'telegram' ? 'Бот не может писать: разреши это в Telegram' : '')
    if (result === 'unavailable') setError('Напоминания сейчас недоступны. Попробуй позже')
    return result
  }

  async function answerYes() {
    setBusy(true)
    const result = await connect()
    setBusy(false)
    // «Нет» системе не меняет настройку: другие устройства получают напоминания, а здесь строка объяснит.
    await save(result === 'ok' ? { offerAnswered: true, moodReminder: { enabled: true } } : { offerAnswered: true })
  }

  async function toggle(on: boolean) {
    if (on && !(await deviceIsSubscribed()) && channel !== 'telegram') {
      setBusy(true)
      const result = await connect()
      setBusy(false)
      if (result !== 'ok') return setState({ ...state })
    }
    await save({ moodReminder: { enabled: on } })
  }

  if (!state.offerAnswered) {
    return (
      <div className="rd-reminder-offer" data-testid="diary-reminder-offer">
        <p className="rd-reminder-title">Напоминать вечером, в {state.time || MOOD_REMINDER_DEFAULT_TIME}?</p>
        <div className="rd-reminder-actions">
          <Button small round fill disabled={busy} data-testid="diary-reminder-yes" onClick={() => void answerYes()}>
            Да
          </Button>
          <Button
            small
            round
            outline
            disabled={busy}
            data-testid="diary-reminder-no"
            onClick={() => void save({ offerAnswered: true, moodReminder: { enabled: false } })}
          >
            Не нужно
          </Button>
        </div>
        {error && <p className="rd-form-error">{error}</p>}
      </div>
    )
  }

  return (
    <div className="rd-reminder" data-testid="diary-reminder-row">
      <div className="rd-reminder-line">
        <span className="rd-reminder-title">Напоминать о настроении</span>
        <select
          className="rd-reminder-time"
          aria-label="Время напоминания"
          data-testid="diary-reminder-time"
          value={state.time}
          disabled={busy || !state.enabled}
          onChange={(e) => void save({ moodReminder: { time: e.target.value } })}
        >
          {(REMINDER_TIMES.includes(state.time) ? REMINDER_TIMES : [state.time, ...REMINDER_TIMES]).map((time) => (
            <option key={time} value={time}>
              {time}
            </option>
          ))}
        </select>
        <Switch checked={state.enabled && !state.paused} disabled={busy} onChange={(on) => void toggle(on)} />
      </div>
      {blocked && (
        <p className="rd-caption" data-testid="diary-reminder-blocked">
          Уведомления запрещены в настройках. Открой настройки браузера для этого сайта и разреши их
        </p>
      )}
      {state.enabled && state.paused && (
        <div className="rd-reminder-paused" data-testid="diary-reminder-paused">
          <span className="rd-caption">Напоминания на паузе — вернуть?</span>
          <Button small round outline disabled={busy} onClick={() => void save({ moodReminder: { enabled: true } })}>
            Вернуть
          </Button>
        </div>
      )}
      {isWebBuild() && isStandalone() && !isTelegramMiniApp() && (
        <p className="rd-caption" data-testid="diary-quick-checkin">
          Быстрая отметка: удерживай значок Рядом
        </p>
      )}
      {error && <p className="rd-form-error">{error}</p>}
    </div>
  )
}
