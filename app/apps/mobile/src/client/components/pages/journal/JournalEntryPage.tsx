import { Block, Button, Message, Messages, Navbar, Page, Preloader } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useCallback, useEffect, useState } from 'react'
import { DialogApiErrorCode, type DialogApiResponse, type DialogSummaryApiResponse } from '@ryadom/contracts/api/dialogs'
import { apiErrorText, getDialog } from '../../../lib/api'
import { journal } from '../../../lib/journal'
import { matchesQuery, useMediaQuery, WIDE_QUERY } from '../../../lib/viewport'
import { formatJournalDate, nbspDash } from './format'
import { DeleteDialogRow, RecapBlock, UnsavedMark } from './RecapParts'
import ShareSheet, { ShareNavButton } from './ShareSheet'

/**
 * One conversation from the journal: the summary and the messages, if the agent returns them.
 *
 * The body is shared by two places: this route (a phone, or a window narrower than WIDE) and the
 * right pane of the journal on a wide screen. `heading` is on in the pane, where there is no
 * navbar to carry the title.
 */
export function JournalEntryBody({
  dialogId,
  heading = false,
  sharing: sharingFromPage,
  onShareClose,
  onShareable,
  onDeleted,
}: {
  dialogId: string
  heading?: boolean
  /** The route's own navbar carries the share button: the sheet is opened from there, and none is drawn in the text. */
  sharing?: boolean
  onShareClose?: () => void
  onShareable?: (shareable: boolean) => void
  /** The conversation was deleted: the route goes back to the list, the pane clears. */
  onDeleted?: () => void
}) {
  const [dialog, setDialog] = useState<DialogApiResponse | null>(null)
  const [error, setError] = useState('')
  const [sharingHere, setSharingHere] = useState(false)
  const navbarShare = onShareable !== undefined
  const sharing = navbarShare ? Boolean(sharingFromPage) : sharingHere
  const closeShare = navbarShare ? (onShareClose ?? (() => {})) : () => setSharingHere(false)
  const shareable = dialog !== null && dialog.messages.length > 0
  useEffect(() => {
    onShareable?.(shareable)
    return () => onShareable?.(false)
  }, [shareable, onShareable])

  /** Reads the conversation again without the loading state: a recap that was pending may be ready now. */
  const reload = useCallback(() => {
    getDialog(dialogId)
      .then((result) => {
        if (result.ok) setDialog(result.data)
      })
      .catch(() => undefined)
  }, [dialogId])

  function summaryChanged(summary: DialogSummaryApiResponse) {
    setDialog((current) => (current ? { ...current, summary } : current))
  }

  function deleted() {
    void journal.refresh()
    journal.open(null)
    onDeleted?.()
  }

  useEffect(() => {
    let cancelled = false
    setDialog(null)
    setError('')
    getDialog(dialogId)
      .then((result) => {
        if (cancelled) return
        if (result.ok) setDialog(result.data)
        else {
          setError(
            result.code === DialogApiErrorCode.DIALOG_NOT_FOUND ? 'Этот разговор не найден' : 'Разговор недоступен',
          )
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(apiErrorText(err, {}, 'Не получилось открыть разговор'))
      })
    return () => {
      cancelled = true
    }
  }, [dialogId])

  return (
    <div className="rd-entry">
      {heading && dialog && (
        <header className="rd-entry-head">
          <h2 className="rd-entry-title">{nbspDash(dialog.summary?.title ?? 'Разговор')}</h2>
          <p className="rd-caption">{formatJournalDate(dialog.startedAt)}</p>
        </header>
      )}

      {!dialog && !error && (
        <Block className="text-align-center">
          <Preloader />
        </Block>
      )}
      {error && <div className="rd-empty">{error}</div>}

      {dialog?.saved === false && (
        <>
          <UnsavedMark dialog={dialog} />
          <DeleteDialogRow dialogId={dialogId} label="Удалить пометку" onDeleted={deleted} />
        </>
      )}

      {dialog && dialog.saved !== false && dialog.summary && (
        <div className="rd-card">
          {!heading && <p className="rd-caption">{formatJournalDate(dialog.startedAt)}</p>}
          <p className="rd-muted">{dialog.summary.themes.join(', ') || 'Без тем'}</p>
          {dialog.summary.tensionAfter !== null && (
            <p className="rd-caption rd-entry-tension">
              Напряжение: {dialog.summary.tensionBefore ?? '—'} → {dialog.summary.tensionAfter}
            </p>
          )}
        </div>
      )}

      {dialog && dialog.saved !== false && <RecapBlock dialog={dialog} onSummary={summaryChanged} onRefresh={reload} />}

      {/* A finished conversation is read from the start: left alone, Messages scrolls to the last line
          and the summary card above it is out of sight. */}
      {dialog && dialog.messages.length > 0 && (
        <Messages scrollMessages={false}>
          {dialog.messages.map((message) => (
            <Message
              key={message.id}
              type={message.role === 'user' ? 'sent' : 'received'}
              className={message.role === 'assistant' ? 'rd-message-assistant' : undefined}
              text={message.text}
            />
          ))}
        </Messages>
      )}

      {shareable && (
        <>
          {!navbarShare && (
            <Button small outline onClick={() => setSharingHere(true)} data-testid="journal-share" className="rd-share-button">
              Поделиться разговором
            </Button>
          )}
          <ShareSheet dialogId={dialogId} opened={sharing} onClose={closeShare} />
        </>
      )}

      {dialog && dialog.saved !== false && dialog.messages.length === 0 && (
        <div className="rd-empty">
          <p className="rd-muted">Текст этого разговора не сохранён.</p>
        </div>
      )}

      {dialog && dialog.saved !== false && dialog.endedAt && (
        <DeleteDialogRow dialogId={dialogId} label="Удалить разговор" onDeleted={deleted} />
      )}
    </div>
  )
}

export default function JournalEntryPage({ dialogId, f7router }: { dialogId: string; f7router: Router.Router }) {
  const isWide = useMediaQuery(WIDE_QUERY)
  const url = `/diary/journal/${dialogId}/`

  useEffect(() => journal.open(dialogId), [dialogId])

  /*
   * On a wide screen an entry is a pane beside the list, not a screen of its own. Hand back to the
   * list — which shows this entry on the right — when the window widens here, or when the route
   * is entered while already wide (a link, a restored history entry).
   */
  const handOff = useCallback(() => {
    if (!matchesQuery(WIDE_QUERY) || f7router.currentRoute.url !== url) return
    const previous = f7router.history[f7router.history.length - 2]
    if (previous === '/diary/journal/') f7router.back('/diary/journal/', { animate: false })
    else f7router.navigate('/diary/journal/', { reloadCurrent: true, animate: false })
  }, [f7router, url])

  useEffect(() => {
    if (isWide) handOff()
  }, [isWide, handOff])

  const [sharing, setSharing] = useState(false)
  const [shareable, setShareable] = useState(false)
  const [title, setTitle] = useState('Разговор')
  useEffect(() => {
    // The navbar title comes from the list the person just tapped, so it does not flash "Разговор".
    const item = journal.peek(dialogId)
    if (item?.saved === false) setTitle('Разговор не сохранён')
    else if (item?.summary?.title) setTitle(item.summary.title)
  }, [dialogId])

  return (
    <Page name="journal-entry" className="ph-no-capture" onPageAfterIn={handOff}>
      <Navbar backLink="Журнал" title={title} onClickBack={() => journal.open(null)}>
        {shareable && <ShareNavButton onClick={() => setSharing(true)} />}
      </Navbar>
      <JournalEntryBody
        dialogId={dialogId}
        sharing={sharing}
        onShareClose={() => setSharing(false)}
        onShareable={setShareable}
        onDeleted={() => f7router.back('/diary/journal/', { force: true })}
      />
    </Page>
  )
}
