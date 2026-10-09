'use client'

import { useState } from 'react'
import { readHandsFree, writeHandsFree } from '@ryadom/client-core/voice/hands-free'
import { NativeCheckbox } from '@ryadom/ui/components/native-checkbox'
import { WEB_HANDS_FREE_KEY } from '@/lib/storage-keys'

/**
 * "Разговор без рук": the sphere listens by itself, finds where the person stops, and falls silent when
 * spoken over. Off, the person taps to speak and taps to finish. The setting belongs to this browser, not
 * the account, and applies from the next conversation. One row of the settings list.
 */
export default function ProfileHandsFree() {
  const [on, setOn] = useState(() => readHandsFree(WEB_HANDS_FREE_KEY))

  return (
    <li className="px-4 py-3">
      <label className="flex cursor-pointer items-start gap-3" data-testid="hands-free">
        <NativeCheckbox
          checked={on}
          onChange={(event) => {
            writeHandsFree(WEB_HANDS_FREE_KEY, event.target.checked)
            setOn(event.target.checked)
          }}
        />
        <span className="flex flex-col gap-1">
          <span className="text-base leading-[1.35] font-medium text-foreground">Разговор без рук</span>
          <span className="text-[0.8125rem] leading-[1.45] text-dim">
            Просто говори: шар сам поймёт, когда ты закончил(а), и замолчит, если заговорить поверх. Только в
            этом браузере.
          </span>
        </span>
      </label>
    </li>
  )
}
