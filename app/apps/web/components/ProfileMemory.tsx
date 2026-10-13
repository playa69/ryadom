'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleAlert, Plus, Sparkles } from 'lucide-react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
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
import {
  MemoryFactStatus,
  type MemoryApiResponse,
  type MemoryFactApiResponse,
} from '@ryadom/contracts/api/memory'
import { Alert, AlertDescription, AlertTitle } from '@ryadom/ui/components/alert'
import { Badge } from '@ryadom/ui/components/badge'
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { NativeCheckbox } from '@ryadom/ui/components/native-checkbox'
import { Skeleton } from '@ryadom/ui/components/skeleton'
import { cn } from '@ryadom/ui/lib/utils'
import { useOnceFor } from '@/lib/analytics'
import { useAuth, useClient } from '@/lib/auth'
import { HIDE_MEMORY_TEXTS_DEFAULT, memoryCard, pendingForgets, usePendingForgets } from '@/lib/memory'
import { WEB_MEMORY_HIDDEN_KEY } from '@/lib/storage-keys'
import { BUTTON } from './controls'
import { BADGE_COMPACT, RetryButton, StatePanel } from './JournalParts'
import MemoryConsent from './MemoryConsent'
import MemoryFactForm from './MemoryFactForm'
import Modal from './Modal'
import { useNotice } from './Notice'
import { Page, SECTION_HEADING } from './Page'
import { Busy, ModalActions, ModalText, ProfileButton, SettingsSection } from './ProfileParts'
import ProfileRow from './ProfileRow'

/**
 * Profile → Память: the switch "Запоминать" and everything the agent remembers, grouped the way a
 * person thinks of it, each fact with where it came from and what can be done with it. Above the
 * facts "Забыть всё"; below them the download and "Как это работает".
 *
 * The texts are the person's own words: the profile is under `NoCapture`, nothing here is reported but
 * the kind of action, and nothing is stored in the browser but the "hide texts" switch. A browser is
 * where computers are shared, so the texts start hidden behind "Показать" until the person says this
 * one is theirs. Reading, forgetting and the download work even while memory is off or unavailable.
 */

const LOAD_FALLBACK = 'Не получилось загрузить память'

/** A small action under a fact. */
const ACTION = cn(BUTTON, 'h-9 border-input! px-3.5 text-sm')

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
  onAction(action: MemoryFactAction): void
}) {
  const source = memoryFactSource(fact)
  const badge = memoryFactBadge(fact)
  return (
    <li>
      <Card
        className={cn(
          'gap-2.5 rounded-lg px-4 py-3.5 shadow-none',
          fact.status === MemoryFactStatus.Proposed && 'border-brand-line',
          fact.status === MemoryFactStatus.Candidate && 'border-dashed',
        )}
        data-testid="memory-fact"
        data-status={fact.status}
      >
        <p
          className={cn(
            'text-base leading-[1.45] wrap-anywhere',
            hidden ? 'text-faint italic' : 'text-foreground',
          )}
          data-testid="memory-fact-text"
        >
          {hidden ? 'Текст скрыт' : fact.text}
        </p>
        {(source || badge) && (
          <p className="flex flex-wrap items-center gap-2 text-[0.8125rem] leading-[1.4] text-faint">
            {badge && (
              <Badge
                variant={fact.status === MemoryFactStatus.Proposed ? 'soft' : 'outline'}
                className={BADGE_COMPACT}
              >
                {badge}
              </Badge>
            )}
            {source}
          </p>
        )}
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-0.5">
            {actions.map((action) => {
              const forget = action === 'delete' || action === 'decline'
              return (
                <Button
                  key={action}
                  type="button"
                  size="sm"
                  variant={action === 'accept' ? 'default' : 'outline'}
                  disabled={busy}
                  className={cn(
                    ACTION,
                    action === 'accept' && 'border-transparent! bg-clip-border',
                    forget && 'text-danger hover:bg-danger-soft hover:text-danger',
                  )}
                  data-testid={`memory-${action}`}
                  onClick={() => onAction(action)}
                >
                  {MEMORY_ACTION_LABEL[action]}
                </Button>
              )
            })}
          </div>
        )}
      </Card>
    </li>
  )
}

function UndoRow({ onUndo }: { onUndo(): void }) {
  return (
    <li>
      <Card
        className="flex-row items-center justify-between gap-3 rounded-lg px-4 py-2.5 shadow-none"
        data-testid="memory-undo"
      >
        <span className="text-[0.9375rem] text-dim">Забыл.</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={cn(ACTION, 'border-0!')}
          onClick={onUndo}
          data-testid="memory-undo-button"
        >
          Вернуть
        </Button>
      </Card>
    </li>
  )
}

function FactList({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col gap-2">{children}</ul>
}

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

export default function ProfileMemory() {
  const client = useClient()
  const notify = useNotice()
  const { updateUser } = useAuth()
  const [memory, setMemory] = useState<MemoryApiResponse | null>(null)
  const [loadError, setLoadError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [sheet, setSheet] = useState<'consent' | 'info' | null>(null)
  const [consentError, setConsentError] = useState('')
  const [editing, setEditing] = useState<{ fact: MemoryFactApiResponse | null } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [hideTexts, setHideTexts] = useState(HIDE_MEMORY_TEXTS_DEFAULT)
  const [revealed, setRevealed] = useState(false)
  const [forgetAllOpen, setForgetAllOpen] = useState(false)
  const [forgettingAll, setForgettingAll] = useState(false)
  const [exporting, setExporting] = useState(false)
  const pending = usePendingForgets()
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

  async function retry() {
    setRetrying(true)
    await load()
    setRetrying(false)
  }

  async function setEnabled(enabled: boolean) {
    setSwitching(true)
    setConsentError('')
    const fallback = enabled ? 'Не получилось включить память' : 'Не получилось выключить память'
    try {
      const result = await client.setMemoryEnabled(enabled)
      if (!result.ok) {
        const text = codeText(MEMORY_SETTINGS_ERRORS, result.code, fallback)
        if (sheet === 'consent') setConsentError(text)
        else notify(text, 'error')
        return
      }
      setMemory((current) => (current ? { ...current, ...result.data } : current))
      updateUser({ memoryEnabled: memory !== null && memoryInUse({ ...memory, ...result.data }) })
      track(AnalyticsEvent.MemoryEnabled, { enabled: result.data.enabled })
      setSheet(null)
      notify(
        result.data.enabled
          ? 'Память включена'
          : 'Память выключена. Запомненное осталось, его можно забыть здесь',
        'success',
      )
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

  /** "Забыть" and "Не запоминать": hidden at once, sent when the seconds for "Вернуть" are over. */
  function forget(fact: MemoryFactApiResponse, action: 'delete' | 'decline') {
    pendingForgets.schedule(fact.id, async () => {
      try {
        const result = await client.forgetMemoryFact(fact.id)
        if (!result.ok) {
          notify(codeText(MEMORY_FORGET_ERRORS, result.code, 'Не получилось забыть'), 'error')
          return
        }
        track(AnalyticsEvent.MemoryFactAction, { action })
        memoryCard.remove(fact.id)
        setMemory((current) =>
          current ? { ...current, facts: current.facts.filter((item) => item.id !== fact.id) } : current,
        )
      } catch (err) {
        notify(apiErrorText(err, {}, 'Не получилось забыть'), 'error')
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
      const result = await client.updateMemoryFact(fact.id, memoryFactChange(action))
      if (!result.ok) {
        notify(codeText(MEMORY_FACT_ERRORS, result.code, 'Не получилось'), 'error')
        return
      }
      track(AnalyticsEvent.MemoryFactAction, { action })
      memoryCard.update(result.data)
      setMemory((current) =>
        current ? { ...current, facts: replaceMemoryFact(current.facts, result.data) } : current,
      )
    } catch (err) {
      notify(apiErrorText(err, {}, 'Не получилось'), 'error')
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
    notify(created ? 'Запомнил' : 'Исправил', 'success')
  }

  async function forgetAll() {
    setForgettingAll(true)
    try {
      const result = await client.forgetAllMemory()
      if (!result.ok) {
        notify(codeText(MEMORY_FORGET_ERRORS, result.code, 'Не получилось забыть'), 'error')
        return
      }
      track(AnalyticsEvent.MemoryForgetAll)
      pendingForgets.cancelAll()
      memoryCard.close()
      setMemory((current) => (current ? { ...current, facts: [] } : current))
      setForgetAllOpen(false)
      notify('Я всё забыл', 'success')
    } catch (err) {
      notify(apiErrorText(err, {}, 'Не получилось забыть'), 'error')
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
    return (
      <FactList>
        {facts.map((fact) =>
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
        )}
      </FactList>
    )
  }

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

      {hiddenSection && (
        <StatePanel data-testid="memory-not-yet">
          <Sparkles aria-hidden="true" className="size-8 text-faint" strokeWidth={1.6} />
          <p className="max-w-[46ch] text-[0.9375rem] leading-normal text-dim">Память пока недоступна.</p>
        </StatePanel>
      )}

      {memory && view && (
        <>
          <SettingsSection title="Настройка" testId="memory-settings">
            <li className="px-4 py-3">
              <label className="flex cursor-pointer items-start gap-3" data-testid="memory-switch">
                <NativeCheckbox
                  checked={memory.enabled}
                  disabled={switching || (!memory.available && !memory.enabled)}
                  aria-busy={switching || undefined}
                  onChange={(event) => handleSwitch(event.target.checked)}
                />
                <span className="flex flex-col gap-1">
                  <span className="text-base leading-[1.35] font-medium text-foreground">Запоминать</span>
                  <span className="text-[0.8125rem] leading-[1.45] text-dim">
                    {memory.enabled
                      ? 'Я помню важное из наших разговоров, чтобы не начинать с нуля. Ты видишь всё, что я запомнил, и можешь это исправить или забыть.'
                      : 'Пока память выключена, я ничего не запоминаю и не пользуюсь запомненным. Без неё всё остальное работает так же.'}
                  </span>
                </span>
              </label>
            </li>
          </SettingsSection>

          {!memory.available && (
            <Alert variant="destructive" data-testid="memory-unavailable" className="gap-y-1 px-5 py-4">
              <CircleAlert aria-hidden="true" />
              <AlertTitle className="font-bold">Недоступно сейчас</AlertTitle>
              <AlertDescription className="text-[0.9375rem] leading-normal text-dim">
                Память временно не работает. Посмотреть, забыть и скачать запомненное можно и сейчас.
              </AlertDescription>
            </Alert>
          )}

          {hasFacts && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Действия с памятью">
              {canChange && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={ACTION}
                  onClick={() => setEditing({ fact: null })}
                  data-testid="memory-add"
                >
                  <Plus aria-hidden="true" />
                  Добавить
                </Button>
              )}
              {hideTexts && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={ACTION}
                  aria-pressed={revealed}
                  onClick={() => setRevealed((value) => !value)}
                  data-testid="memory-reveal"
                >
                  {revealed ? 'Скрыть тексты' : 'Показать'}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(ACTION, 'text-danger hover:bg-danger-soft hover:text-danger')}
                onClick={() => setForgetAllOpen(true)}
                data-testid="memory-forget-all"
              >
                Забыть всё
              </Button>
            </div>
          )}

          {view.proposed.length > 0 && (
            <section
              className="flex flex-col gap-2"
              data-testid="memory-proposed"
              aria-labelledby="memory-proposed"
            >
              <h2 id="memory-proposed" className={SECTION_HEADING}>
                Ждут твоего решения
              </h2>
              <p className="px-1 text-[0.8125rem] leading-[1.45] text-faint">
                Это важное и личное, поэтому я сначала спрашиваю. Пока ты не ответишь, я этим не пользуюсь.
              </p>
              {renderFacts(view.proposed)}
            </section>
          )}

          {view.groups.map((group) => (
            <section
              key={group.id}
              className="flex flex-col gap-2"
              data-testid="memory-group"
              data-group={group.id}
              aria-labelledby={`memory-group-${group.id}`}
            >
              <h2 id={`memory-group-${group.id}`} className={SECTION_HEADING}>
                {group.title}
              </h2>
              {group.id === 'guesses' && (
                <p className="px-1 text-[0.8125rem] leading-[1.45] text-faint">
                  Мои догадки. Я ими не пользуюсь, пока ты не скажешь «Верно» или это не повторится в другом
                  разговоре.
                </p>
              )}
              {renderFacts(group.facts)}
            </section>
          ))}

          {!hasFacts && (
            <StatePanel data-testid="memory-empty">
              <Sparkles aria-hidden="true" className="size-8 text-faint" strokeWidth={1.6} />
              <p className="max-w-[46ch] text-[0.9375rem] leading-normal text-dim">
                {!memory.available
                  ? 'Память сейчас недоступна. Загляни позже.'
                  : memory.enabled
                    ? 'Пока я ничего не запомнил. После разговора я покажу, что запомнил, а здесь это можно будет исправить или забыть.'
                    : 'Если включить память, я буду помнить важное из наших разговоров. Всё запомненное будет здесь.'}
              </p>
              {canChange && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={ACTION}
                  onClick={() => setEditing({ fact: null })}
                  data-testid="memory-add"
                >
                  <Plus aria-hidden="true" />
                  Добавить самому
                </Button>
              )}
            </StatePanel>
          )}

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
            {hasFacts && (
              <li>
                <ProfileRow
                  icon="download"
                  label={exporting ? 'Готовим файл…' : 'Скачать мою память'}
                  testId="memory-export"
                  onClick={() => void download()}
                />
              </li>
            )}
            <li>
              <ProfileRow
                icon="help"
                label="Как это работает"
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

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.fact ? 'Исправить' : 'Добавить в память'}
        className="max-h-[calc(100dvh-1rem)] overflow-y-auto tab:w-[min(92vw,560px)]"
      >
        <MemoryFactForm
          fact={editing?.fact ?? null}
          categories={memory ? newMemoryFactCategories(memory.facts) : []}
          onSaved={saved}
          onCancel={() => setEditing(null)}
        />
      </Modal>

      <Modal
        open={forgetAllOpen}
        onClose={() => setForgetAllOpen(false)}
        title="Забыть всё?"
        dismissible={!forgettingAll}
      >
        <ModalText>
          Я забуду всё, что запомнил. Разговоры останутся в журнале. Вернуть забытое будет нельзя.
        </ModalText>
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
            Забыть всё
          </ProfileButton>
        </ModalActions>
      </Modal>
    </Page>
  )
}
