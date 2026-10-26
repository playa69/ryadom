'use client'

import { useEffect, useState } from 'react'
import { RECAP_AUTO_LABEL } from '@ryadom/client-core/recaps'
import { NativeCheckbox } from '@ryadom/ui/components/native-checkbox'
import { useClient } from '@/lib/auth'

/**
 * «Подводить итог автоматически» in the journal (add-mood-diary, D13): the same switch as in the end sheet, apart from the
 * switch «Запоминать» of memory. Nothing is shown until the setting is read.
 */
export default function RecapAutoSetting() {
  const client = useClient()
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    client
      .getDialogSettings()
      .then((settings) => !cancelled && setEnabled(settings.recapEnabled))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [client])

  if (enabled === null) return null

  async function change(next: boolean) {
    setEnabled(next)
    try {
      setEnabled((await client.putDialogSettings(next)).recapEnabled)
    } catch {
      setEnabled(!next)
    }
  }

  return (
    <label className="flex cursor-pointer items-start gap-3 px-1" data-testid="recap-auto-setting">
      <NativeCheckbox checked={enabled} onChange={(event) => void change(event.target.checked)} />
      <span className="flex flex-col gap-0.5">
        <span className="text-base leading-snug text-foreground">{RECAP_AUTO_LABEL}</span>
        <span className="text-[0.8125rem] leading-[1.45] text-faint">
          После разговора я напишу короткий итог. Его можно написать самому.
        </span>
      </span>
    </label>
  )
}
