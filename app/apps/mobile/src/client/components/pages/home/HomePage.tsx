import { Button, Icon, Page } from 'framework7-react'
import type { Router } from 'framework7/types'
import { useState } from 'react'
import { DialogMode, StartDialogApiErrorCode } from '@ryadom/contracts/api/dialogs'
import { apiErrorText, codeText, startDialog } from '../../../lib/api'
import { unlockSpeech } from '../../../lib/voice/speech'
import { useAuth } from '../../../lib/store'
import { SHORT_QUERY, useMediaQuery, WIDE_QUERY } from '../../../lib/viewport'
import Breathing from '../../Breathing'
import { SosButton, openSos } from '../../SosSheet'

/**
 * Home screen: the breathing circle, one large talk button and the modes.
 *
 * In v0 only the venting mode works. The other modes exist in the contract, but enabling them
 * before the agent supports them would be a promise the product cannot keep.
 */

const MODES: Array<{ id: DialogMode; label: string; hint: string; icon: string; ready: boolean }> = [
  {
    id: DialogMode.Vent,
    label: 'Выговориться',
    hint: 'Просто слушаю, без советов',
    icon: 'heart',
    ready: true,
  },
  {
    id: DialogMode.Chat,
    label: 'Поболтать',
    hint: 'Лёгкий разговор ни о чём',
    icon: 'chat_bubble',
    ready: false,
  },
  {
    id: DialogMode.Journal,
    label: 'Дневник',
    hint: 'Вопросы, чтобы лучше понять себя',
    icon: 'book',
    ready: false,
  },
  {
    id: DialogMode.RitualEvening,
    label: 'Вечерний ритуал',
    hint: 'Дыхание, слова, маленькое действие',
    icon: 'moon',
    ready: false,
  },
]

const START_ERRORS: Record<StartDialogApiErrorCode, string> = {
  [StartDialogApiErrorCode.USER_NOT_FOUND]: 'Аккаунт недоступен. Войди заново',
  [StartDialogApiErrorCode.USER_INACTIVE]: 'Аккаунт заблокирован. Напиши нам, разберёмся',
}

function greeting(name: string | null): string {
  const hour = new Date().getHours()
  const part =
    hour < 5 ? 'Поздний вечер' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер'
  return name ? `${part}, ${name}` : part
}

export default function HomePage({ f7router }: { f7router: Router.Router }) {
  const { auth } = useAuth()
  const isWide = useMediaQuery(WIDE_QUERY)
  const isShort = useMediaQuery(SHORT_QUERY)
  const [mode, setMode] = useState<DialogMode>(DialogMode.Vent)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleTalk() {
    // The conversation opens on the voice and the sphere speaks first: speech is let through by this tap.
    unlockSpeech()
    setError('')
    setLoading(true)
    try {
      const result = await startDialog(mode)
      if (!result.ok) {
        setError(codeText(START_ERRORS, result.code, 'Не получилось начать разговор'))
        return
      }
      f7router.navigate(`/dialog/${result.data.dialogId}/`, {
        props: {
          greeting: result.data.greeting,
          resumed: result.data.resumed,
          sinceLastDialogHours: result.data.sinceLastDialogHours,
          // The button says "talk": the conversation opens on the voice screen and already listens.
          listen: true,
        },
      })
    } catch (err) {
      setError(apiErrorText(err, {}, 'Не получилось начать разговор'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Page name="home">
      {/* slot="fixed" keeps the button outside .page-content: without it the button is
          absolutely positioned relative to the scroll container and would scroll away with
          the page the moment its content grows taller than the screen (design review). */}
      <SosButton slot="fixed" />
      {/* One column on a phone; from WIDE the circle and the actions stand side by side. */}
      <div className="rd-home">
        <div className="rd-home-orb">
          <Breathing size={isWide ? 280 : isShort ? 188 : 232} />
        </div>
        <div className="rd-home-main">
          <p className="rd-home-greeting">{greeting(auth.user?.name ?? null)}</p>
          <p className="rd-muted rd-home-lead">Я здесь и никуда не спешу. О чём хочется сказать?</p>

          <div className="rd-talk">
            <Button
              fill
              large
              preloader
              loading={loading}
              disabled={loading}
              onClick={() => void handleTalk()}
            >
              Поговорить
            </Button>
          </div>

          <div className="rd-modes">
            {MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`rd-mode${mode === item.id ? ' rd-mode--active' : ''}`}
                disabled={!item.ready}
                onClick={() => setMode(item.id)}
              >
                <span className="rd-mode-icon">
                  <Icon f7={item.icon} size={22} />
                </span>
                <span className="rd-mode-text">
                  <span className="rd-mode-label">{item.label}</span>
                  <span className="rd-mode-hint">{item.hint}</span>
                </span>
                {/* `title` alone is a tooltip, and touch input never fires hover, so on a phone a row
                  that is not ready explained nothing (design review). Visible text works everywhere. */}
                {item.ready ? (
                  <Icon f7="chevron_right" size={16} />
                ) : (
                  <span className="rd-mode-soon">скоро</span>
                )}
              </button>
            ))}
          </div>
          {error && (
            <p className="rd-form-error" data-testid="form-error">
              {error}
            </p>
          )}

          <div className="rd-home-people">
            <div className="rd-note">
              <span className="rd-note-tile">
                <Icon f7="person_2" size={22} className="rd-note-icon" />
              </span>
              <div className="rd-note-body">
                <p className="rd-note-title">Люди рядом</p>
                <p className="rd-note-text">
                  Линии помощи, а со временем&nbsp;— группы поддержки и специалисты. Разговор со мной не
                  заменяет живых людей.
                </p>
                <Button small round outline onClick={() => openSos()}>
                  Посмотреть
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Page>
  )
}
