import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import {
  Block,
  BlockTitle,
  Button,
  Icon,
  List,
  ListItem,
  Navbar,
  Page,
  Preloader,
  f7,
} from 'framework7-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MEMORY_ACTION_LABEL,
  MEMORY_FACT_ERRORS,
  MEMORY_FORGET_ERRORS,
  MEMORY_SETTINGS_ERRORS,
  groupMemory,
  memoryExportFileName,
  memoryExportText,
  memoryFactActions,
  memoryFactBadge,
  memoryFactChange,
  memoryFactSource,
  memoryInUse,
  needsMemoryConsent,
  newMemoryFactCategories,
  readHideMemoryTexts,
  replaceMemoryFact,
  shouldShowMemorySection,
  writeHideMemoryTexts,
  type MemoryFactAction,
} from '@ryadom/client-core/memory'
import type { MemoryApiResponse, MemoryFactApiResponse } from '@ryadom/contracts/api/memory'
import {
  apiErrorText,
  codeText,
  exportMemory,
  forgetAllMemory,
  forgetMemoryFact,
  getMemory,
  setMemoryEnabled,
  updateMemoryFact,
} from '../../../lib/api'
import { saveTextFile } from '../../../lib/download'
import {
  HIDE_MEMORY_TEXTS_DEFAULT,
  HIDE_MEMORY_TEXTS_KEY,
  memoryCard,
  pendingForgets,
  usePendingForgets,
} from '../../../lib/memory'
import { useAuth } from '../../../lib/store'
import Switch from '../../Switch'
import MemoryConsentSheet from './MemoryConsentSheet'
import MemoryFactSheet from './MemoryFactSheet'

/**
 * Profile → Память: the switch "Запоминать" and everything the agent remembers, grouped the way a
 * person thinks of it, each fact with where it came from and what can be done with it. Above the
 * facts "Забыть всё"; below them the download and "Как это работает".
 *
 * The texts are the person's own words: the page carries `ph-no-capture`, nothing here is reported
 * but the kind of action, and nothing is stored on the device but the "hide texts" switch. Reading,
 * forgetting and the download work even while memory is off or unavailable.
 */

const LOAD_FALLBACK = 'Не получилось загрузить память'

function FactCard({
  fact,
  actions,
  hidden,
  busy,
  onAction,
}: {
  fact: MemoryFactApiResponse
  actions: MemoryFactAction[]
  hidden: boolean
  busy: boolean
  onAction: (action: MemoryFactAction) => void
}) {
  const source = memoryFactSource(fact)
  const badge = memoryFactBadge(fact)
  return (
    <div className="rd-memory-fact" data-testid="memory-fact" data-status={fact.status}>
      <p className={`rd-memory-fact-text${hidden ? ' rd-memory-fact-text--hidden' : ''}`}>
        {hidden ? 'Текст скрыт' : fact.text}
      </p>
      {(source || badge) && (
        <p className="rd-memory-fact-meta">
          {badge && <span className="rd-memory-badge">{badge}</span>}
          {source}
        </p>
      )}
      {actions.length > 0 && (
        <div className="rd-memory-fact-actions">
          {actions.map((action) => (
            <Button
              key={action}
              small
              round
              outline={action !== 'accept'}
              fill={action === 'accept'}
              disabled={busy}
              className={action === 'delete' || action === 'decline' ? 'rd-memory-forget' : undefined}
              data-testid={`memory-${action}`}
              onClick={() => onAction(action)}
            >
              {MEMORY_ACTION_LABEL[action]}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function UndoRow({ onUndo }: { onUndo: () => void }) {
  return (
    <div className="rd-memory-fact rd-memory-undo" data-testid="memory-undo">
      <span className="rd-caption">Забыл.</span>
      <Button small round onClick={onUndo} data-testid="memory-undo-button">
        Вернуть
      </Button>
    </div>
  )
}

export default function MemoryPage() {
  const { updateUser } = useAuth()
  const [memory, setMemory] = useState<MemoryApiResponse | null>(null)
  const [loadError, setLoadError] = useState('')
  const [retrying, setRetrying] = useState(false)
  /** The switch as the person sees it: it moves at once and goes back if the answer is no. */
  const [switchOn, setSwitchOn] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [sheet, setSheet] = useState<'consent' | 'info' | null>(null)
  const [consentError, setConsentError] = useState('')
  const [editing, setEditing] = useState<{ fact: MemoryFactApiResponse | null } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [hideTexts, setHideTexts] = useState(() =>
    readHideMemoryTexts(HIDE_MEMORY_TEXTS_KEY, HIDE_MEMORY_TEXTS_DEFAULT),
  )
  const [revealed, setRevealed] = useState(false)
  const [exporting, setExporting] = useState(false)
  const pending = usePendingForgets()
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
      setMemory((current) => (current ? { ...current, ...result.data } : current))
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
        toast(codeText(MEMORY_SETTINGS_ERRORS, result.code, 'Не получилось выключить память'))
        setSwitchOn(true)
        return
      }
      setMemory((current) => (current ? { ...current, ...result.data } : current))
      setSwitchOn(result.data.enabled)
      updateUser({ memoryEnabled: false })
      track(AnalyticsEvent.MemoryEnabled, { enabled: false })
      toast('Память выключена. Запомненное осталось, его можно забыть здесь')
    } catch (error) {
      toast(apiErrorText(error, {}, 'Не получилось выключить память'))
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

  function closeSheet() {
    if (switching) return
    // Closing the consent without an answer leaves memory as it was.
    if (sheet === 'consent' && !memory?.enabled) setSwitchOn(false)
    setSheet(null)
  }

  /** "Забыть" and "Не запоминать": hidden at once, sent when the seconds for "Вернуть" are over. */
  function forget(fact: MemoryFactApiResponse, action: 'delete' | 'decline') {
    pendingForgets.schedule(fact.id, async () => {
      try {
        const result = await forgetMemoryFact(fact.id)
        if (!result.ok) {
          toast(codeText(MEMORY_FORGET_ERRORS, result.code, 'Не получилось забыть'))
          return
        }
        track(AnalyticsEvent.MemoryFactAction, { action })
        memoryCard.remove(fact.id)
        setMemory((current) =>
          current ? { ...current, facts: current.facts.filter((item) => item.id !== fact.id) } : current,
        )
      } catch (error) {
        toast(apiErrorText(error, {}, 'Не получилось забыть'))
      }
    })
  }

  async function act(fact: MemoryFactApiResponse, action: MemoryFactAction) {
    if (action === 'edit') {
      setEditing({ fact })
      return
    }
    if (action === 'delete' || action === 'decline') {
      forget(fact, action)
      return
    }
    setBusyId(fact.id)
    try {
      const result = await updateMemoryFact(fact.id, memoryFactChange(action))
      if (!result.ok) {
        toast(codeText(MEMORY_FACT_ERRORS, result.code, 'Не получилось'))
        return
      }
      track(AnalyticsEvent.MemoryFactAction, { action })
      memoryCard.update(result.data)
      setMemory((current) =>
        current ? { ...current, facts: replaceMemoryFact(current.facts, result.data) } : current,
      )
    } catch (error) {
      toast(apiErrorText(error, {}, 'Не получилось'))
    } finally {
      setBusyId(null)
    }
  }

  function saved(fact: MemoryFactApiResponse, created: boolean) {
    // The catalog counts corrections; a fact the person adds is not one of its actions.
    if (!created) track(AnalyticsEvent.MemoryFactAction, { action: 'edit' })
    setMemory((current) =>
      current
        ? { ...current, facts: created ? [...current.facts, fact] : replaceMemoryFact(current.facts, fact) }
        : current,
    )
    memoryCard.update(fact)
    setEditing(null)
    toast(created ? 'Запомнил' : 'Исправил')
  }

  function confirmForgetAll() {
    f7.dialog.confirm(
      'Я забуду всё, что запомнил. Разговоры останутся в журнале. Вернуть забытое будет нельзя.',
      'Забыть всё?',
      () => void forgetAll(),
    )
  }

  async function forgetAll() {
    try {
      const result = await forgetAllMemory()
      if (!result.ok) {
        toast(codeText(MEMORY_FORGET_ERRORS, result.code, 'Не получилось забыть'))
        return
      }
      track(AnalyticsEvent.MemoryForgetAll)
      pendingForgets.cancelAll()
      memoryCard.close()
      setMemory((current) => (current ? { ...current, facts: [] } : current))
      toast('Я всё забыл')
    } catch (error) {
      toast(apiErrorText(error, {}, 'Не получилось забыть'))
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
          'Скачать мою память',
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
  // switched on): a neutral word, no switch and no actions.
  const hiddenSection = memory !== null && !shouldShowMemorySection(memory)
  const view = memory && !hiddenSection ? groupMemory(memory.facts) : null
  const canChange = memory !== null && memory.available && memory.enabled
  const hidden = hideTexts && !revealed
  const hasFacts = (view?.count ?? 0) > 0
  // While memory is off or unavailable the facts are only read and forgotten.
  const actionsOf = (fact: MemoryFactApiResponse): MemoryFactAction[] =>
    canChange
      ? memoryFactActions(fact)
      : memoryFactActions(fact).filter((action) => action === 'delete' || action === 'decline')

  function renderFacts(facts: MemoryFactApiResponse[]) {
    return facts.map((fact) =>
      pending.has(fact.id) ? (
        <UndoRow key={fact.id} onUndo={() => pendingForgets.undo(fact.id)} />
      ) : (
        <FactCard
          key={fact.id}
          fact={fact}
          actions={actionsOf(fact)}
          hidden={hidden}
          busy={busyId === fact.id}
          onAction={(action) => void act(fact, action)}
        />
      ),
    )
  }

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

      {memory && view && (
        <>
          <List inset strong className="rd-menu">
            <ListItem title="Запоминать" data-testid="memory-switch">
              <Icon slot="media" f7="sparkles" />
              <Switch
                slot="after"
                checked={switchOn}
                disabled={switching || (!memory.available && !memory.enabled)}
                onChange={handleSwitch}
              />
            </ListItem>
          </List>
          <Block>
            <p className="rd-caption">
              {memory.enabled
                ? 'Я помню важное из наших разговоров, чтобы не начинать с нуля. Ты видишь всё, что я запомнил, и можешь это исправить или забыть.'
                : 'Пока память выключена, я ничего не запоминаю и не пользуюсь запомненным. Без неё всё остальное работает так же.'}
            </p>
          </Block>

          {!memory.available && (
            <div className="rd-note rd-note--danger" data-testid="memory-unavailable">
              <Icon f7="exclamationmark_circle" size={22} className="rd-note-icon" />
              <div className="rd-note-body">
                <p className="rd-note-title">Недоступно сейчас</p>
                <p className="rd-caption">
                  Память временно не работает. Посмотреть, забыть и скачать запомненное можно и сейчас.
                </p>
              </div>
            </div>
          )}

          {hasFacts && (
            <div className="rd-memory-toolbar">
              {canChange && (
                <Button
                  small
                  round
                  outline
                  onClick={() => setEditing({ fact: null })}
                  data-testid="memory-add"
                >
                  <Icon f7="plus" size={16} />
                  Добавить
                </Button>
              )}
              {hideTexts && (
                <Button
                  small
                  round
                  outline
                  onClick={() => setRevealed((value) => !value)}
                  data-testid="memory-reveal"
                >
                  {revealed ? 'Скрыть' : 'Показать'}
                </Button>
              )}
              <Button
                small
                round
                outline
                className="rd-memory-forget"
                onClick={confirmForgetAll}
                data-testid="memory-forget-all"
              >
                Забыть всё
              </Button>
            </div>
          )}

          {view.proposed.length > 0 && (
            <section data-testid="memory-proposed">
              <BlockTitle>Ждут твоего решения</BlockTitle>
              <Block>
                <p className="rd-caption">
                  Это важное и личное, поэтому я сначала спрашиваю. Пока ты не ответишь, я этим не пользуюсь.
                </p>
              </Block>
              {renderFacts(view.proposed)}
            </section>
          )}

          {view.groups.map((group) => (
            <section key={group.id} data-testid="memory-group" data-group={group.id}>
              <BlockTitle>{group.title}</BlockTitle>
              {group.id === 'guesses' && (
                <Block>
                  <p className="rd-caption">
                    Мои догадки. Я ими не пользуюсь, пока ты не скажешь «Верно» или это не повторится в другом
                    разговоре.
                  </p>
                </Block>
              )}
              {renderFacts(group.facts)}
            </section>
          ))}

          {!hasFacts && (
            <div className="rd-empty" data-testid="memory-empty">
              <Icon f7="sparkles" size={32} />
              <p className="rd-muted">
                {!memory.available
                  ? 'Память сейчас недоступна. Загляни позже.'
                  : memory.enabled
                    ? 'Пока я ничего не запомнил. После разговора я покажу, что запомнил, а здесь это можно будет исправить или забыть.'
                    : 'Если включить память, я буду помнить важное из наших разговоров. Всё запомненное будет здесь.'}
              </p>
              {canChange && (
                <Button
                  outline
                  round
                  className="rd-empty-action"
                  onClick={() => setEditing({ fact: null })}
                  data-testid="memory-add"
                >
                  Добавить самому
                </Button>
              )}
            </div>
          )}

          <BlockTitle>На этом устройстве</BlockTitle>
          <List inset strong className="rd-menu">
            <ListItem title="Скрывать тексты" data-testid="memory-hide-texts">
              <Icon slot="media" f7="eye_slash" />
              <Switch
                slot="after"
                checked={hideTexts}
                onChange={(on) => {
                  writeHideMemoryTexts(HIDE_MEMORY_TEXTS_KEY, on)
                  setHideTexts(on)
                  setRevealed(false)
                }}
              />
            </ListItem>
          </List>
          <Block>
            <p className="rd-caption">
              Если устройством пользуется кто-то ещё: тексты будут спрятаны, пока не нажмёшь «Показать».
            </p>
          </Block>

          <List inset strong dividers className="rd-menu">
            {hasFacts && (
              <ListItem
                link
                title="Скачать мою память"
                onClick={() => void download()}
                data-testid="memory-export"
              >
                <Icon slot="media" f7="arrow_down_doc" />
                {exporting && <Preloader slot="after" size={18} />}
              </ListItem>
            )}
            <ListItem link title="Как это работает" onClick={() => setSheet('info')} data-testid="memory-how">
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
      <MemoryFactSheet
        opened={editing !== null}
        fact={editing?.fact ?? null}
        categories={memory ? newMemoryFactCategories(memory.facts) : []}
        onSaved={saved}
        onClose={() => setEditing(null)}
      />
    </Page>
  )
}
