import { Button, f7, Icon, Preloader, Sheet } from 'framework7-react'
import { useCallback, useEffect, useState } from 'react'
import { DialogApiErrorCode } from '@ryadom/contracts/api/dialogs'
import {
  DIALOG_SHARE_DEFAULT_TTL_HOURS,
  DIALOG_SHARE_TTL_HOURS,
  DialogShareApiErrorCode,
  type DialogShareApiResponse,
  type DialogShareTtlHours,
} from '@ryadom/contracts/api/dialog-shares'
import { apiErrorText, codeText, createDialogShare, getDialogShare, revokeDialogShare } from '../../../lib/api'
import { shareExpiryText, shareViewsText } from './format'

const TTL_LABEL: Record<DialogShareTtlHours, string> = { 24: '24 ч', 72: '3 дня', 168: '7 дней' }

const ERROR_TEXT: Record<DialogApiErrorCode | DialogShareApiErrorCode, string> = {
  [DialogApiErrorCode.DIALOG_NOT_FOUND]: 'Этот разговор не найден',
  [DialogApiErrorCode.USER_NOT_FOUND]: 'Аккаунт недоступен',
  [DialogApiErrorCode.USER_INACTIVE]: 'Аккаунт недоступен',
  [DialogShareApiErrorCode.SHARE_EXISTS]: 'У этого разговора уже есть ссылка',
  [DialogShareApiErrorCode.SHARE_LIMIT]: 'Активных ссылок уже пять. Отзови одну из них в другом разговоре',
  [DialogShareApiErrorCode.SHARE_DISABLED]: 'Ссылки сейчас недоступны',
}

type State =
  | { status: 'loading' }
  | { status: 'error'; text: string }
  | { status: 'none' }
  | { status: 'active'; share: DialogShareApiResponse }

const toast = (text: string) => f7.toast.create({ text, closeTimeout: 2500 }).open()

/**
 * "Поделиться" (`REQ-DATA-05`): one link per conversation, in a sheet. Without one it asks for the
 * term and warns what the other person will see; with one it shows the link again, to copy, to hand
 * to the system share sheet, or to revoke. The link opens the web client, whichever app made it.
 */
export default function ShareSheet({
  dialogId,
  opened,
  onClose,
}: {
  dialogId: string
  opened: boolean
  onClose: () => void
}) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [ttl, setTtl] = useState<DialogShareTtlHours>(DIALOG_SHARE_DEFAULT_TTL_HOURS)
  const [busy, setBusy] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const load = useCallback(() => {
    setState({ status: 'loading' })
    setConfirmRevoke(false)
    getDialogShare(dialogId)
      .then((result) => {
        if (!result.ok) setState({ status: 'error', text: codeText(ERROR_TEXT, result.code, 'Не получилось открыть') })
        else setState(result.data ? { status: 'active', share: result.data } : { status: 'none' })
      })
      .catch((err: unknown) => setState({ status: 'error', text: apiErrorText(err, {}, 'Не получилось открыть') }))
  }, [dialogId])

  useEffect(() => {
    if (opened) load()
  }, [opened, load])

  async function create() {
    setBusy(true)
    try {
      const result = await createDialogShare(dialogId, { ttlHours: ttl })
      if (result.ok) setState({ status: 'active', share: result.data })
      else toast(codeText(ERROR_TEXT, result.code, 'Не получилось создать ссылку'))
    } catch (err) {
      toast(apiErrorText(err, {}, 'Не получилось создать ссылку'))
    } finally {
      setBusy(false)
    }
  }

  async function revoke() {
    setBusy(true)
    try {
      const result = await revokeDialogShare(dialogId)
      if (result.ok) {
        setState({ status: 'none' })
        setConfirmRevoke(false)
        toast('Ссылка отозвана')
      } else toast(codeText(ERROR_TEXT, result.code, 'Не получилось отозвать'))
    } catch (err) {
      toast(apiErrorText(err, {}, 'Не получилось отозвать'))
    } finally {
      setBusy(false)
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      toast('Ссылка скопирована')
    } catch {
      toast('Не получилось скопировать. Выдели ссылку и скопируй вручную')
    }
  }

  async function send(share: DialogShareApiResponse) {
    try {
      await navigator.share({
        text: `Поделился(-ась) разговором с тобой в «Рядом». Ссылка действует до ${shareExpiryText(share.expiresAt)}.`,
        url: share.url,
      })
    } catch {
      // Closing the system sheet is a cancellation, not an error.
    }
  }

  return (
    <Sheet opened={opened} onSheetClosed={onClose} swipeToClose closeOnEscape backdrop style={{ height: 'auto' }}>
      <div className="rd-sheet-body" data-testid="share-sheet">
        <h2 className="rd-sheet-title">Поделиться разговором</h2>

        {state.status === 'loading' && (
          <div className="text-align-center">
            <Preloader />
          </div>
        )}

        {state.status === 'error' && (
          <>
            <p className="rd-form-error" role="alert">
              {state.text}
            </p>
            <Button large onClick={load}>
              Повторить
            </Button>
          </>
        )}

        {state.status === 'none' && (
          <>
            <p className="rd-muted">Получатель откроет разговор по ссылке, без входа в приложение. Он только читает.</p>
            <p className="rd-caption">Ссылка действует</p>
            <div className="rd-segment" role="radiogroup" aria-label="Срок ссылки">
              {DIALOG_SHARE_TTL_HOURS.map((hours) => (
                <button
                  key={hours}
                  type="button"
                  role="radio"
                  aria-checked={ttl === hours}
                  data-testid={`share-ttl-${hours}`}
                  onClick={() => setTtl(hours)}
                >
                  {TTL_LABEL[hours]}
                </button>
              ))}
            </div>
            <p className="rd-warning" data-testid="share-warning">
              Получатель увидит <b>весь текст</b> разговора как есть. Сводка, оценки напряжения и голос не передаются.
              Ссылку можно отозвать в любой момент.
            </p>
            <Button fill large disabled={busy} onClick={() => void create()} data-testid="share-create">
              Создать ссылку
            </Button>
            <Button large onClick={onClose}>
              Отмена
            </Button>
          </>
        )}

        {state.status === 'active' && (
          <>
            <p className="rd-share-ok" data-testid="share-active">
              ✓ Ссылка активна
            </p>
            <input
              className="rd-share-url"
              readOnly
              value={state.share.url}
              aria-label="Ссылка на разговор"
              data-testid="share-url"
              onFocus={(event) => event.currentTarget.select()}
            />
            <p className="rd-caption" data-testid="share-meta">
              Действует до {shareExpiryText(state.share.expiresAt)} · {shareViewsText(state.share.viewCount)}
            </p>
            {canShare && (
              <Button fill large onClick={() => void send(state.share)} data-testid="share-send">
                Отправить…
              </Button>
            )}
            <Button fill={!canShare} large onClick={() => void copy(state.share.url)} data-testid="share-copy">
              Скопировать ссылку
            </Button>
            <p className="rd-caption">Чтобы сменить срок, отзови ссылку и создай новую.</p>
            {confirmRevoke ? (
              <>
                <Button large className="rd-danger" disabled={busy} onClick={() => void revoke()} data-testid="share-revoke-confirm">
                  Да, отозвать
                </Button>
                <Button large onClick={() => setConfirmRevoke(false)}>
                  Нет
                </Button>
              </>
            ) : (
              <Button large className="rd-danger" onClick={() => setConfirmRevoke(true)} data-testid="share-revoke">
                Отозвать ссылку
              </Button>
            )}
          </>
        )}
      </div>
    </Sheet>
  )
}

/**
 * The share control of a screen's navigation bar: the system "share" glyph (an arrow out of a box), the way
 * iOS and the apps built on this client mark it, at the right of the bar before SOS. Icon only: the name is
 * for screen readers.
 */
export function ShareNavButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      slot="right"
      type="button"
      className="rd-navbar-icon ph-no-capture"
      aria-label="Поделиться разговором"
      data-testid="share-nav"
      onClick={onClick}
    >
      <Icon f7="square_arrow_up" size={22} />
    </button>
  )
}
