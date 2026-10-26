import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Block, Button, Icon, List, ListItem, Navbar, Page, Preloader, f7 } from 'framework7-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MEMORY_FORGET_ERRORS,
  MEMORY_SETTINGS_ERRORS,
  MEMORY_SHEET,
  MEMORY_SWITCHES,
  memoryExportFileName,
  memoryExportText,
  memoryInUse,
  memorySwitches,
  needsMemoryConsent,
  shouldShowMemorySection,
} from '@ryadom/client-core/memory'
import type { MemoryApiResponse } from '@ryadom/contracts/api/memory'
import {
  apiErrorText,
  codeText,
  exportMemory,
  forgetAllMemory,
  getMemory,
  setMemoryEnabled,
  updateMemorySettings,
} from '../../../lib/api'
import { saveTextFile } from '../../../lib/download'
import { pendingForgets } from '../../../lib/memory'
import { useAuth } from '../../../lib/store'
import Switch from '../../Switch'
import MemoryConsentSheet from './MemoryConsentSheet'
import MemoryNotesSheet from './MemoryNotesSheet'

/**
 * Profile → Память: three switches ("Память" is a pause when off, "Запоминать чувствительное",
 * "Опираться на прошлые разговоры"), the way into the sheet "Что помнит Рядом", the download,
 * "Удалить всю память" and "Как это работает". The notes themselves live in the sheet.
 *
 * The texts of the notes are the person's own words: nothing here is reported but the kind of action.
 * Reading, deleting and the download work even while memory is paused or unavailable.
 */

const LOAD_FALLBACK = 'Не получилось загрузить память'

export default function MemoryPage() {
  const { updateUser } = useAuth()
  const [memory, setMemory] = useState<MemoryApiResponse | null>(null)
  const [loadError, setLoadError] = useState('')
  const [retrying, setRetrying] = useState(false)
  /** The "Память" switch as the person sees it: it moves at once and goes back if the answer is no. */
  const [switchOn, setSwitchOn] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [settingBusy, setSettingBusy] = useState(false)
  /** Bumped when a refused change must move its switch back. */
  const [epoch, setEpoch] = useState(0)
  const [sheet, setSheet] = useState<'consent' | 'info' | null>(null)
  const [notesOpened, setNotesOpened] = useState(false)
  const [consentError, setConsentError] = useState('')
  const [exporting, setExporting] = useState(false)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const mine = ++generation.current
    try {
      const next = await getMemory()
      if (mine !== generation.current) return
      setMemory(next)
      setSwitchOn(next.enabled)
      setLoadError('')
      updateUser({ memoryEnabled: memoryInUse(next) })
    } catch (error) {
      if (mine === generation.current) setLoadError(apiErrorText(error, {}, LOAD_FALLBACK))
    }
  }, [updateUser])

  useEffect(() => {
    track(AnalyticsEvent.MemoryScreenOpened)
    void load()
  }, [load])

  const toast = (text: string) => f7.toast.create({ text, closeTimeout: 2500 }).open()

  async function enable() {
    setSwitching(true)
    setConsentError('')
    try {
      const result = await setMemoryEnabled(true)
      if (!result.ok) {
        const text = codeText(MEMORY_SETTINGS_ERRORS, result.code, 'Не получилось включить память')
        if (sheet === 'consent') setConsentError(text)
        else toast(text)
        setSwitchOn(false)
        return
      }
      setMemory((current) => (current ? { ...current, ...result.data, paused: false } : current))
      setSwitchOn(result.data.enabled)
      updateUser({ memoryEnabled: memory !== null && memoryInUse({ ...memory, ...result.data }) })
      track(AnalyticsEvent.MemoryEnabled, { enabled: true })
      setSheet(null)
      toast('Память включена')
    } catch (error) {
      const text = apiErrorText(error, {}, 'Не получилось включить память')
      if (sheet === 'consent') setConsentError(text)
      else toast(text)
      setSwitchOn(false)
    } finally {
      setSwitching(false)
    }
  }

  async function disable() {
    setSwitching(true)
    try {
      const result = await setMemoryEnabled(false)
      if (!result.ok) {
        toast(codeText(MEMORY_SETTINGS_ERRORS, result.code, 'Не получилось поставить память на паузу'))
        setSwitchOn(true)
        return
      }
      setMemory((current) => (current ? { ...current, ...result.data, paused: true } : current))
      setSwitchOn(result.data.enabled)
      updateUser({ memoryEnabled: false })
      track(AnalyticsEvent.MemoryEnabled, { enabled: false })
      toast('Память на паузе. Заметки остались, Рядом их не использует')
    } catch (error) {
      toast(apiErrorText(error, {}, 'Не получилось поставить память на паузу'))
      setSwitchOn(true)
    } finally {
      setSwitching(false)
    }
  }

  function handleSwitch(on: boolean) {
    if (!memory || switching) return
    setSwitchOn(on)
    if (!on) {
      void disable()
      return
    }
    // The sheet comes first unless this very text was accepted before.
    if (needsMemoryConsent(memory)) {
      setConsentError('')
      setSheet('consent')
    } else {
      void enable()
    }
  }

  /** "Запоминать чувствительное" and "Опираться на прошлые разговоры": no `enabled`, so no consent. */
  async function changeSetting(change: { sensitiveEnabled: boolean } | { chatSearchEnabled: boolean }) {
    if (settingBusy) return
    setSettingBusy(true)
    try {
      const result = await updateMemorySettings(change)
      if (!result.ok) {
        toast(codeText(MEMORY_SETTINGS_ERRORS, result.code, 'Не получилось изменить'))
      } else {
        setMemory((current) => (current ? { ...current, ...result.data } : current))
        return
      }
    } catch (error) {
      toast(apiErrorText(error, {}, 'Не получилось изменить'))
    } finally {
      setSettingBusy(false)
    }
    // A refusal puts the switch back where the server has it.
    setEpoch((value) => value + 1)
  }

  function closeSheet() {
    if (switching) return
    // Closing the consent without an answer leaves memory as it was.
    if (sheet === 'consent' && !memory?.enabled) setSwitchOn(false)
    setSheet(null)
  }

  function confirmForgetAll() {
    f7.dialog.confirm(MEMORY_SHEET.forgetAllConfirm, MEMORY_SHEET.forgetAll, () => void forgetAll())
  }

  async function forgetAll() {
    try {
      const result = await forgetAllMemory()
      if (!result.ok) {
        toast(codeText(MEMORY_FORGET_ERRORS, result.code, 'Не получилось удалить'))
        return
      }
      track(AnalyticsEvent.MemoryForgetAll)
      pendingForgets.cancelAll()
      // The switches and the consent stay as they were: only the notes go.
      setMemory((current) => (current ? { ...current, notes: [], facts: [] } : current))
      toast('Вся память удалена')
    } catch (error) {
      toast(apiErrorText(error, {}, 'Не получилось удалить'))
    }
  }

  async function download() {
    if (exporting) return
    setExporting(true)
    try {
      const data = await exportMemory()
      const handed = await saveTextFile(memoryExportFileName(), memoryExportText(data))
      if (handed) track(AnalyticsEvent.MemoryExport)
      else
        f7.dialog.alert(
          'В приложении файл пока не сохраняется. Скачать его можно в браузере, в веб-версии «Рядом».',
          MEMORY_SHEET.download,
        )
    } catch (error) {
      toast(apiErrorText(error, {}, 'Не получилось скачать'))
    } finally {
      setExporting(false)
    }
  }

  async function retry() {
    setRetrying(true)
    await load()
    setRetrying(false)
  }

  // The feature is off on the server and the person has nothing there (a link opened before it was
  // switched on): a neutral word, no switches and no actions.
  const hiddenSection = memory !== null && !shouldShowMemorySection(memory)
  const switches = memory ? memorySwitches(memory) : null

  return (
    // Coming back to the tab (after a conversation, say) reads what is remembered now.
    <Page name="memory" className="ph-no-capture" onPageTabShow={() => void load()}>
      <Navbar backLink="Назад" title="Память" />

      {memory === null && !loadError && (
        <Block className="rd-center">
          <Preloader />
        </Block>
      )}

      {memory === null && loadError && (
        <div className="rd-empty">
          <p className="rd-muted" data-testid="form-error">
            {loadError}
          </p>
          <Button
            outline
            round
            className="rd-empty-action"
            loading={retrying}
            preloader
            onClick={() => void retry()}
          >
            Попробовать ещё раз
          </Button>
        </div>
      )}

      {hiddenSection && (
        <div className="rd-empty" data-testid="memory-not-yet">
          <Icon f7="sparkles" size={32} />
          <p className="rd-muted">Память пока недоступна.</p>
        </div>
      )}

      {memory && switches && !hiddenSection && (
        <>
          <List inset strong className="rd-menu">
            <ListItem title={MEMORY_SWITCHES.memory.title} footer={MEMORY_SWITCHES.memory.hint} data-testid="memory-switch">
              <Icon slot="media" f7="sparkles" />
              <Switch
                slot="after"
                checked={switchOn}
                disabled={switching || (!memory.available && !memory.enabled)}
                onChange={handleSwitch}
              />
            </ListItem>
            <ListItem
              title={MEMORY_SWITCHES.sensitive.title}
              footer={MEMORY_SWITCHES.sensitive.hint}
              data-testid="memory-sensitive-switch"
            >
              <Icon slot="media" f7="heart" />
              <Switch
                key={`sensitive-${epoch}`}
                slot="after"
                checked={switches.sensitive}
                disabled={switches.sensitiveDisabled || settingBusy}
                onChange={(on) => void changeSetting({ sensitiveEnabled: on })}
              />
            </ListItem>
            <ListItem
              title={MEMORY_SWITCHES.chatSearch.title}
              footer={MEMORY_SWITCHES.chatSearch.hint}
              data-testid="memory-chat-search-switch"
            >
              <Icon slot="media" f7="search" />
              <Switch
                key={`search-${epoch}`}
                slot="after"
                checked={switches.chatSearch}
                disabled={switches.chatSearchDisabled || settingBusy}
                onChange={(on) => void changeSetting({ chatSearchEnabled: on })}
              />
            </ListItem>
          </List>

          {!memory.available && (
            <div className="rd-note rd-note--danger" data-testid="memory-unavailable">
              <Icon f7="exclamationmark_circle" size={22} className="rd-note-icon" />
              <div className="rd-note-body">
                <p className="rd-note-title">Недоступно сейчас</p>
                <p className="rd-caption">
                  Память временно не работает. Посмотреть, удалить и скачать заметки можно и сейчас.
                </p>
              </div>
            </div>
          )}

          <List inset strong dividers className="rd-menu">
            <ListItem
              link
              title={`${MEMORY_SHEET.open} →`}
              onClick={() => setNotesOpened(true)}
              data-testid="memory-open-notes"
            >
              <Icon slot="media" f7="list_bullet" />
            </ListItem>
            <ListItem
              link
              title={MEMORY_SHEET.download}
              onClick={() => void download()}
              data-testid="memory-export"
            >
              <Icon slot="media" f7="arrow_down_doc" />
              {exporting && <Preloader slot="after" size={18} />}
            </ListItem>
            <ListItem
              link
              title={MEMORY_SHEET.forgetAll}
              onClick={confirmForgetAll}
              data-testid="memory-forget-all"
            >
              <Icon slot="media" f7="trash" />
            </ListItem>
            <ListItem link title={MEMORY_SHEET.howItWorks} onClick={() => setSheet('info')} data-testid="memory-how">
              <Icon slot="media" f7="question_circle" />
            </ListItem>
          </List>
        </>
      )}

      <MemoryConsentSheet
        opened={sheet !== null}
        kind={sheet ?? 'info'}
        busy={switching}
        error={consentError}
        onAccept={() => void enable()}
        onClose={closeSheet}
      />
      <MemoryNotesSheet opened={notesOpened} onClose={() => setNotesOpened(false)} onChanged={() => void load()} />
    </Page>
  )
}
