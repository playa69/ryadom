import { Block, Button, List, ListItem, f7 } from 'framework7-react'
import { useCallback, useEffect, useState } from 'react'
import {
  disablePush,
  enablePush,
  openPushSettings,
  pushEnabled,
  pushPermission,
  pushSupported,
} from '../../../lib/push'
import Switch from '../../Switch'

/**
 * «Уведомления» in the profile (`push-notifications`, «Включение уведомлений на телефоне»): this phone only, off until
 * the person turns it on, and the system asks for permission only then. A refusal leaves it off and says where to
 * allow them; the state is read again when the person comes back from the settings.
 *
 * Rendered only where the build can receive them (`pushSupported`): the Android app with the plugin in its APK.
 */
export default function PushSetting() {
  const [enabled, setEnabled] = useState(pushEnabled)
  const [permission, setPermission] = useState<'granted' | 'denied' | 'prompt' | null>(null)
  const [refused, setRefused] = useState(false)
  const [busy, setBusy] = useState(false)
  // Each attempt ends with a fresh switch: one that failed to turn on has to move back by itself (see Switch).
  const [attempt, setAttempt] = useState(0)

  const readPermission = useCallback(() => {
    if (!pushSupported()) return
    void pushPermission()
      .then((state) => {
        setPermission(state)
        if (state === 'granted') setRefused(false)
      })
      .catch(() => setPermission(null))
  }, [])

  useEffect(() => {
    readPermission()
    const onVisible = () => document.visibilityState === 'visible' && readPermission()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [readPermission])

  async function change(on: boolean) {
    setBusy(true)
    try {
      if (!on) {
        await disablePush()
        setEnabled(false)
        return
      }
      const outcome = await enablePush()
      setEnabled(outcome === 'enabled')
      readPermission()
      switch (outcome) {
        case 'enabled':
          setRefused(false)
          f7.toast.create({ text: 'Уведомления включены', closeTimeout: 1500 }).open()
          break
        case 'denied':
          setRefused(true)
          break
        case 'unavailable':
          f7.toast
            .create({
              text: 'Не получилось включить уведомления. Нужен RuStore: установи его или открой хотя бы раз',
              closeTimeout: 3000,
            })
            .open()
          break
        case 'failed':
          f7.toast
            .create({ text: 'Не получилось включить уведомления. Попробуй чуть позже', closeTimeout: 2500 })
            .open()
          break
      }
    } finally {
      setBusy(false)
      setAttempt((n) => n + 1)
    }
  }

  if (!pushSupported()) return null
  // Turned on here, then taken back in the system settings: it is off in fact, and the reason is shown.
  const blocked = refused || (enabled && permission !== null && permission !== 'granted')
  const on = enabled && permission === 'granted'

  return (
    <>
      <List inset strong className="rd-menu">
        <ListItem title="Уведомления" data-testid="push-toggle">
          <Switch
            key={attempt}
            slot="after"
            checked={on}
            disabled={busy}
            onChange={(next) => void change(next)}
          />
        </ListItem>
      </List>
      <Block>
        {blocked ? (
          <>
            <p className="rd-caption">Уведомления запрещены в настройках телефона.</p>
            <Button small outline round onClick={() => void openPushSettings()}>
              Открыть настройки
            </Button>
          </>
        ) : (
          <p className="rd-caption">Сообщения от Рядом на этот телефон.</p>
        )}
      </Block>
    </>
  )
}
