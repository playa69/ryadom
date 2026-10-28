'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MEMORY_SHEET_REFRESH_MS, readHideMemoryTexts } from '@ryadom/client-core/memory'
import type { MemoryApiResponse, MemoryNoteApiResponse } from '@ryadom/contracts/api/memory'
import { useClient } from '@/lib/auth'
import { HIDE_MEMORY_TEXTS_DEFAULT } from '@/lib/memory'
import { WEB_MEMORY_HIDDEN_KEY } from '@/lib/storage-keys'
import MemoryNotesSheet from './MemoryNotesSheet'

/**
 * The sheet "Что помнит Рядом" opened from the header of a conversation (`design.md`, the sheet from the conversation).
 * The list is read when the sheet opens and again every `MEMORY_SHEET_REFRESH_MS` while it stays open, so a note made during
 * the conversation appears without closing and reopening it. The texts start hidden behind "Показать" as in the profile
 * (a browser is where computers are shared). Nothing is kept in the browser but the device's "hide texts" choice.
 */
export default function DialogMemory({ open, onClose }: { open: boolean; onClose(): void }) {
  const client = useClient()
  const [memory, setMemory] = useState<MemoryApiResponse | null>(null)
  const [hideTexts, setHideTexts] = useState(HIDE_MEMORY_TEXTS_DEFAULT)
  const [revealed, setRevealed] = useState(false)
  const generation = useRef(0)

  // The device's choice is read after hydration: the server renders the default.
  useEffect(() => {
    setHideTexts(readHideMemoryTexts(WEB_MEMORY_HIDDEN_KEY, HIDE_MEMORY_TEXTS_DEFAULT))
  }, [])

  const load = useCallback(async () => {
    const mine = ++generation.current
    try {
      const next = await client.getMemory()
      if (mine === generation.current) setMemory(next)
    } catch {
      // A failed read keeps what is on the sheet; the next one tries again.
    }
  }, [client])

  useEffect(() => {
    if (!open) return
    setRevealed(false)
    void load()
    const timer = setInterval(() => void load(), MEMORY_SHEET_REFRESH_MS)
    return () => clearInterval(timer)
  }, [open, load])

  function updateNotes(update: (current: MemoryNoteApiResponse[]) => MemoryNoteApiResponse[]) {
    setMemory((current) => (current ? { ...current, notes: update(current.notes) } : current))
  }

  return (
    <MemoryNotesSheet
      open={open && memory !== null}
      notes={memory?.notes ?? []}
      paused={memory !== null && !memory.enabled}
      hidden={hideTexts && !revealed}
      canReveal={hideTexts}
      revealed={revealed}
      onToggleReveal={() => setRevealed((value) => !value)}
      onNotes={updateNotes}
      onClose={onClose}
    />
  )
}
