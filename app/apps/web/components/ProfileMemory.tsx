'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent, type MemorySettingName } from '@ryadom/analytics/events'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import {
  MEMORY_FORGET_ERRORS,
  MEMORY_SETTINGS_ERRORS,
  MEMORY_REINDEXING_LABEL,
  MEMORY_REINDEXING_POLL_MS,
  MEMORY_SHEET,
  MEMORY_SWITCHES,
  memoryExportFileName,
  memoryExportText,
  memoryInUse,
  memorySwitches,
  needsMemoryConsent,
  isReindexing,
  readHideMemoryTexts,
  writeHideMemoryTexts,
} from '@ryadom/client-core/memory'
import type { MemoryApiResponse, MemoryNoteApiResponse } from '@ryadom/contracts/api/memory'
import { Alert, AlertDescription, AlertTitle } from '@ryadom/ui/components/alert'
import { NativeCheckbox } from '@ryadom/ui/components/native-checkbox'
import { Skeleton } from '@ryadom/ui/components/skeleton'
import { useOnceFor } from '@/lib/analytics'
import { useAuth, useClient } from '@/lib/auth'
import { HIDE_MEMORY_TEXTS_DEFAULT, pendingForgets } from '@/lib/memory'
import { WEB_MEMORY_HIDDEN_KEY } from '@/lib/storage-keys'
import { RetryButton, StatePanel } from './JournalParts'
import MemoryConsent from './MemoryConsent'
import MemoryNotesSheet from './MemoryNotesSheet'
import Modal from './Modal'
import { useNotice } from './Notice'
import { Page } from './Page'
import { Busy, ModalActions, ModalText, ProfileButton, SettingsSection } from './ProfileParts'
import ProfileRow from './ProfileRow'

/**
 * Profile → Память: three switches ("Память" is a pause, the notes stay; "Запоминать чувствительное";
 * "Опираться на прошлые разговоры"), the button that opens the sheet "Что помнит Рядом" with the notes,
 * the download, "Удалить всю память" and "Как это работает".
 *
 * The texts are the person's own words: the profile is under `NoCapture`, nothing here is reported but
 * the kind of action, and nothing is stored in the browser but the "hide texts" switch. A browser is
 * where computers are shared, so the texts start hidden behind "Показать" until the person says this
 * one is theirs. Reading, deleting and the download work even while memory is paused or unavailable.
 */

const LOAD_FALLBACK = 'Не получилось загрузить память'

function LoadingState() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-busy="true" data-testid="memory-loading">
      <span className="sr-only">Загружаем память…</span>
      <Skeleton className="h-14 w-full rounded-lg motion-reduce:animate-none" />
      <Skeleton className="ml-1 h-3.5 w-32 motion-reduce:animate-none" />
      <Skeleton className="h-20 w-full rounded-lg motion-reduce:animate-none" />
    </div>
  )
}

function SwitchRow({
  title,
  hint,
  checked,
  disabled,
  busy,
  testId,
  onChange,
}: {
  title: string
  hint: string
  checked: boolean
  disabled: boolean
  busy: boolean
  testId: string
  onChange(on: boolean): void
}) {
  return (
    <li className="px-4 py-3">
      <label className="flex cursor-pointer items-start gap-3" data-testid={testId}>
        <NativeCheckbox
          checked={checked}
          disabled={disabled}
          aria-busy={busy || undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="flex flex-col gap-1">
          <span className="text-base leading-[1.35] font-medium text-foreground">{title}</span>
          <span className="text-[0.8125rem] leading-[1.45] text-dim">{hint}</span>
        </span>
      </label>
    </li>
  )
}

export default function ProfileMemory() {
  const client = useClient()
  const notify = useNotice()
  const { updateUser } = useAuth()
  const [memory, setMemory] = useState<MemoryApiResponse | null>(null)
  const [loadError, setLoadError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [sheet, setSheet] = useState<'consent' | 'info' | null>(null)
  const [notesOpen, setNotesOpen] = useState(false)
  const [consentError, setConsentError] = useState('')
  const [hideTexts, setHideTexts] = useState(HIDE_MEMORY_TEXTS_DEFAULT)
  const [revealed, setRevealed] = useState(false)
  const [forgetAllOpen, setForgetAllOpen] = useState(false)
  const [forgettingAll, setForgettingAll] = useState(false)
  const [exporting, setExporting] = useState(false)
  const generation = useRef(0)

  useOnceFor('memory', () => track(AnalyticsEvent.MemoryScreenOpened))

  // The device's choice is read after hydration: the server renders the default.
  useEffect(() => {
    setHideTexts(readHideMemoryTexts(WEB_MEMORY_HIDDEN_KEY, HIDE_MEMORY_TEXTS_DEFAULT))
  }, [])

  const load = useCallback(async () => {
    const mine = ++generation.current
    try {
      const next = await client.getMemory()
      if (mine !== generation.current) return
      setMemory(next)
      setLoadError('')
      updateUser({ memoryEnabled: memoryInUse(next) })
    } catch (err) {
      if (mine === generation.current) setLoadError(apiErrorText(err, {}, LOAD_FALLBACK))
    }
  }, [client, updateUser])

  useEffect(() => {
    void load()
  }, [load])

  // While the agent rebuilds the index of past conversations the label is shown; the section is read again until it is gone.
  const reindexing = isReindexing(memory)
  useEffect(() => {
    if (!reindexing) return
    const timer = setInterval(() => void load(), MEMORY_REINDEXING_POLL_MS)
    return () => clearInterval(timer)
  }, [reindexing, load])

  async function retry() {
    setRetrying(true)
    await load()
    setRetrying(false)
  }

  async function setEnabled(enabled: boolean) {
    setSwitching(true)
    setConsentError('')
    const fallback = enabled ? 'Не получилось включить память' : 'Не получилось поставить память на паузу'
    try {
      const result = await client.setMemoryEnabled(enabled)
      if (!result.ok) {
        const text = codeText(MEMORY_SETTINGS_ERRORS, result.code, fallback)
        if (sheet === 'consent') setConsentError(text)
        else notify(text, 'error')
        return
      }
      setMemory((current) => (current ? { ...current, ...result.data, paused: !result.data.enabled } : current))
      updateUser({ memoryEnabled: memory !== null && memoryInUse({ ...memory, ...result.data }) })
      track(AnalyticsEvent.MemoryEnabled, { enabled: result.data.enabled })
      track(AnalyticsEvent.MemorySettingChanged, { setting: 'memory', enabled: result.data.enabled })
      setSheet(null)
      notify(result.data.enabled ? 'Память включена' : 'Память на паузе. Заметки остались', 'success')
    } catch (err) {
      const text = apiErrorText(err, {}, fallback)
      if (sheet === 'consent') setConsentError(text)
      else notify(text, 'error')
    } finally {
      setSwitching(false)
    }
  }

  function handleSwitch(on: boolean) {
    if (!memory || switching) return
    // Turning it on shows the consent first unless this very text was accepted before.
    if (on && needsMemoryConsent(memory)) {
      setConsentError('')
      setSheet('consent')
      return
    }
    void setEnabled(on)
  }

  /** The two lower switches: without `enabled`, so no consent is involved. */
  async function setOption(setting: Extract<MemorySettingName, 'sensitive' | 'chat_search'>, on: boolean) {
    if (!memory || switching) return
    setSwitching(true)
    const fallback = 'Не получилось изменить настройку'
    try {
      const result = await client.updateMemorySettings(
        setting === 'sensitive' ? { sensitiveEnabled: on } : { chatSearchEnabled: on },
      )
      if (!result.ok) {
        notify(codeText(MEMORY_SETTINGS_ERRORS, result.code, fallback), 'error')
        return
      }
      track(AnalyticsEvent.MemorySettingChanged, { setting, enabled: on })
      setMemory((current) =>
        current
          ? { ...current, sensitiveEnabled: result.data.sensitiveEnabled, chatSearchEnabled: result.data.chatSearchEnabled }
          : current,
      )
      // Turning "чувствительное" off deletes the sensitive notes: the list is read again.
      // Turning the search on starts the rebuild of the index: the section reads again to show "Готовлю память…".
      if ((setting === 'sensitive' && !on) || (setting === 'chat_search' && on)) await load()
    } catch (err) {
      notify(apiErrorText(err, {}, fallback), 'error')
    } finally {
      setSwitching(false)
    }
  }

  function updateNotes(update: (current: MemoryNoteApiResponse[]) => MemoryNoteApiResponse[]) {
    setMemory((current) => (current ? { ...current, notes: update(current.notes) } : current))
  }

  function openNotes() {
    track(AnalyticsEvent.MemorySheetOpened, { source: 'profile' })
    setNotesOpen(true)
  }

  async function forgetAll() {
    setForgettingAll(true)
    try {
      const result = await client.forgetAllMemory()
      if (!result.ok) {
        notify(codeText(MEMORY_FORGET_ERRORS, result.code, 'Не получилось удалить'), 'error')
        return
      }
      track(AnalyticsEvent.MemoryForgetAll)
      track(AnalyticsEvent.MemoryReset)
      pendingForgets.cancelAll()
      // The switches and the consent stay as they were.
      setMemory((current) => (current ? { ...current, notes: [], facts: [] } : current))
      setForgetAllOpen(false)
      notify('Вся память удалена', 'success')
    } catch (err) {
      notify(apiErrorText(err, {}, 'Не получилось удалить'), 'error')
    } finally {
      setForgettingAll(false)
    }
  }

  async function download() {
    if (exporting) return
    setExporting(true)
    try {
      const data = await client.exportMemory()
      const url = URL.createObjectURL(new Blob([memoryExportText(data)], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = memoryExportFileName()
      document.body.append(link)
      link.click()
      link.remove()
      // The click has started the download; the object URL is no longer needed.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      track(AnalyticsEvent.MemoryExport)
    } catch (err) {
      notify(apiErrorText(err, {}, 'Не получилось скачать'), 'error')
    } finally {
      setExporting(false)
    }
  }

  const switches = memory ? memorySwitches(memory) : null

  return (
    <Page title="Память" back={{ href: '/profile', label: 'Профиль' }} data-testid="memory">
      {memory === null && !loadError && <LoadingState />}

      {memory === null && loadError && (
        <StatePanel>
          <p className="text-[0.9375rem] leading-[1.4] text-danger" role="alert" data-testid="form-error">
            {loadError}
          </p>
          <RetryButton busy={retrying} onClick={() => void retry()} />
        </StatePanel>
      )}

      {memory && switches && (
        <>
          <SettingsSection title="Настройка" testId="memory-settings">
            <SwitchRow
              title={MEMORY_SWITCHES.memory.title}
              hint={MEMORY_SWITCHES.memory.hint}
              checked={switches.memory}
              disabled={switching || (!memory.available && !memory.enabled)}
              busy={switching}
              testId="memory-switch"
              onChange={handleSwitch}
            />
            <SwitchRow
              title={MEMORY_SWITCHES.sensitive.title}
              hint={MEMORY_SWITCHES.sensitive.hint}
              checked={switches.sensitive}
              disabled={switching || switches.sensitiveDisabled}
              busy={switching}
              testId="memory-switch-sensitive"
              onChange={(on) => void setOption('sensitive', on)}
            />
            <SwitchRow
              title={MEMORY_SWITCHES.chatSearch.title}
              hint={MEMORY_SWITCHES.chatSearch.hint}
              checked={switches.chatSearch}
              disabled={switching || switches.chatSearchDisabled}
              busy={switching}
              testId="memory-switch-chat-search"
              onChange={(on) => void setOption('chat_search', on)}
            />
            {reindexing && (
              <li className="px-4 pb-3 text-sm text-dim" role="status" data-testid="memory-reindexing">
                {MEMORY_REINDEXING_LABEL}
              </li>
            )}
          </SettingsSection>

          {!memory.available && (
            <Alert variant="destructive" data-testid="memory-unavailable" className="gap-y-1 px-5 py-4">
              <CircleAlert aria-hidden="true" />
              <AlertTitle className="font-bold">Недоступно сейчас</AlertTitle>
              <AlertDescription className="text-[0.9375rem] leading-normal text-dim">
                Память временно не работает. Посмотреть, удалить и скачать заметки можно и сейчас.
              </AlertDescription>
            </Alert>
          )}

          <SettingsSection title="Заметки">
            <li>
              <ProfileRow
                icon="memory"
                label={MEMORY_SHEET.open}
                value={memory.notes.length > 0 ? String(memory.notes.length) : undefined}
                testId="memory-open"
                onClick={openNotes}
              />
            </li>
            <li>
              <ProfileRow
                icon="download"
                label={exporting ? 'Готовим файл…' : MEMORY_SHEET.download}
                testId="memory-export"
                onClick={() => void download()}
              />
            </li>
            <li>
              <ProfileRow
                icon="trash"
                danger
                label={MEMORY_SHEET.forgetAll}
                testId="memory-forget-all"
                onClick={() => setForgetAllOpen(true)}
              />
            </li>
          </SettingsSection>

          <SettingsSection
            title="На этом устройстве"
            note="Если компьютером пользуется кто-то ещё: тексты будут спрятаны, пока не нажмёшь «Показать». Только в этом браузере."
          >
            <li className="px-4 py-3">
              <label className="flex cursor-pointer items-start gap-3" data-testid="memory-hide-texts">
                <NativeCheckbox
                  checked={hideTexts}
                  onChange={(event) => {
                    writeHideMemoryTexts(WEB_MEMORY_HIDDEN_KEY, event.target.checked)
                    setHideTexts(event.target.checked)
                    setRevealed(false)
                  }}
                />
                <span className="text-base leading-[1.35] font-medium text-foreground">Скрывать тексты</span>
              </label>
            </li>
          </SettingsSection>

          <SettingsSection title="Ещё">
            <li>
              <ProfileRow
                icon="help"
                label={MEMORY_SHEET.howItWorks}
                testId="memory-how"
                onClick={() => setSheet('info')}
              />
            </li>
          </SettingsSection>
        </>
      )}

      <MemoryConsent
        open={sheet !== null}
        kind={sheet ?? 'info'}
        busy={switching}
        error={consentError}
        onAccept={() => void setEnabled(true)}
        onClose={() => {
          if (!switching) setSheet(null)
        }}
      />

      <MemoryNotesSheet
        open={notesOpen && memory !== null}
        notes={memory?.notes ?? []}
        paused={memory !== null && !memory.enabled}
        hidden={hideTexts && !revealed}
        canReveal={hideTexts}
        revealed={revealed}
        onToggleReveal={() => setRevealed((value) => !value)}
        onNotes={updateNotes}
        onClose={() => setNotesOpen(false)}
      />

      <Modal
        open={forgetAllOpen}
        onClose={() => setForgetAllOpen(false)}
        title={MEMORY_SHEET.forgetAll}
        dismissible={!forgettingAll}
      >
        <ModalText>{MEMORY_SHEET.forgetAllConfirm}</ModalText>
        <ModalActions>
          <ProfileButton
            type="button"
            variant="outline"
            disabled={forgettingAll}
            onClick={() => setForgetAllOpen(false)}
          >
            Отмена
          </ProfileButton>
          <ProfileButton
            type="button"
            variant="danger"
            aria-busy={forgettingAll || undefined}
            onClick={() => void forgetAll()}
            data-testid="memory-forget-all-confirm"
          >
            <Busy on={forgettingAll} />
            Удалить
          </ProfileButton>
        </ModalActions>
      </Modal>
    </Page>
  )
}
