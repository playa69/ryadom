import { useEffect, useState } from 'react'
import { RECAP_AUTO_LABEL } from '@ryadom/client-core/recaps'
import { getDialogSettings, putDialogSettings } from '../../../lib/api'

/**
 * «Подводить итог автоматически» in the journal (add-mood-diary, D13): the same switch as in the end sheet, apart from the
 * switch «Запоминать» of memory. Nothing is shown until the setting is read.
 */
export default function RecapAutoSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    getDialogSettings()
      .then((settings) => !cancelled && setEnabled(settings.recapEnabled))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  if (enabled === null) return null

  async function change(next: boolean) {
    setEnabled(next)
    try {
      setEnabled((await putDialogSettings(next)).recapEnabled)
    } catch {
      setEnabled(!next)
    }
  }

  return (
    <label className="rd-recap-auto rd-recap-auto--setting" data-testid="recap-auto-setting">
      <input type="checkbox" checked={enabled} onChange={(event) => void change(event.target.checked)} />
      <span>
        {RECAP_AUTO_LABEL}
        <span className="rd-caption">После разговора я напишу короткий итог. Его можно написать самому.</span>
      </span>
    </label>
  )
}
