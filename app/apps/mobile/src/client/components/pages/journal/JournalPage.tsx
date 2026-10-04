import { Block, BlockTitle, Button, f7, Icon, List, ListItem, Navbar, Page, Preloader } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useEffect, useRef } from 'react'
import { journal, useJournal } from '../../../lib/journal'
import { TAB_IDS } from '../../../lib/nav'
import { useMediaQuery, WIDE_QUERY } from '../../../lib/viewport'
import { SosButton } from '../../SosSheet'
import { formatJournalDate, nbspDash, tensionLabel } from './format'
import { JournalEntryBody } from './JournalEntryPage'

/**
 * Journal: a feed of past conversations with their summaries. The agent stores the
 * content and we only display it.
 *
 * On a wide screen (WIDE, lib/viewport.ts) it is master-detail: the list stays on the left and an
 * entry opens on the right without leaving the screen. Narrower — as on a phone, the entry is its
 * own screen /journal/:id/. Which entry is open lives in lib/journal.ts, so resizing the window
 * keeps the same one open: here when it narrows, in JournalEntryPage when it widens.
 */
export default function JournalPage({ f7router }: { f7router: Router.Router }) {
  const { items, error, openId } = useJournal()
  const isWide = useMediaQuery(WIDE_QUERY)

  useEffect(() => {
    void journal.refresh()
  }, [])

  // The window narrowed with an entry open: on a narrow screen it is a screen of its own.
  const wasWide = useRef(isWide)
  useEffect(() => {
    const narrowed = wasWide.current && !isWide
    wasWide.current = isWide
    if (!narrowed || !openId || f7router.currentRoute.url !== '/journal/') return
    f7router.navigate(`/journal/${openId}/`, { animate: false })
  }, [isWide, openId, f7router])

  function openEntry(dialogId: string) {
    journal.open(dialogId)
    if (!isWide) f7router.navigate(`/journal/${dialogId}/`)
  }

  return (
    // A conversation may have ended on another tab since the list was loaded.
    <Page name="journal" className="rd-journal-page" onPageTabShow={() => void journal.refresh()}>
      <Navbar title="Журнал" />
      {/* slot="fixed": this page has a Navbar, and framework7 only lifts known slot names out of
          .page-content. Left at the default slot, the button was trapped inside .page-content's
          own stacking context and rendered invisible under the navbar (design review). */}
      <SosButton slot="fixed" />

      <div className="rd-split">
        <div className="rd-split-side">
          {items === null && (
            <Block className="text-align-center">
              <Preloader />
            </Block>
          )}

          {items !== null && items.length === 0 && (
            <div className="rd-empty">
              <span className="rd-empty-icon" aria-hidden="true">
                <Icon f7="book" size={28} />
              </span>
              <p className="rd-muted">Здесь появятся твои разговоры.</p>
              {error && (
                <p className="rd-form-error" data-testid="form-error">
                  {error}
                </p>
              )}
              {/* Switch tabs rather than push Home into this one: the tab bar would then point at
                  the journal while showing Home. */}
              <Button round outline className="rd-empty-action" onClick={() => f7.tab.show(`#${TAB_IDS.home}`)}>
                На главную
              </Button>
            </div>
          )}

          {items !== null && items.length > 0 && (
            <>
              <BlockTitle>Разговоры</BlockTitle>
              <List inset strong dividers mediaList className="rd-menu">
                {items.map((item) => (
                  <ListItem
                    key={item.dialogId}
                    link
                    className={
                      isWide && openId === item.dialogId ? 'rd-journal-item rd-journal-item--open' : 'rd-journal-item'
                    }
                    data-testid="journal-item"
                    title={nbspDash(item.summary?.title ?? 'Разговор')}
                    subtitle={formatJournalDate(item.startedAt)}
                    text={item.summary?.themes.join(', ')}
                    after={tensionLabel(item) ?? undefined}
                    onClick={() => openEntry(item.dialogId)}
                  />
                ))}
              </List>
              <Block>
                <p className="rd-caption">
                  Аудио не сохраняется: разговор превращается в текст и остаётся только он. Стереть всё можно в
                  профиле.
                </p>
              </Block>
            </>
          )}
        </div>

        {isWide && (
          <div className="rd-split-main" data-testid="journal-pane">
            {openId ? (
              <JournalEntryBody key={openId} dialogId={openId} heading />
            ) : (
              // With nothing in the list there is nothing to choose: the list's own message says it all.
              items !== null &&
              items.length > 0 && (
                <div className="rd-split-empty">
                  <span className="rd-empty-icon" aria-hidden="true">
                    <Icon f7="book" size={28} />
                  </span>
                  <p className="rd-muted">Выбери разговор слева</p>
                </div>
              )
            )}
          </div>
        )}
      </div>
    </Page>
  )
}
