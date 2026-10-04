import { Block, BlockTitle, Button, Icon, List, ListItem, Navbar, Page, f7 } from 'framework7-react'
import { useState, type ChangeEvent } from 'react'
import { apiErrorText, deleteAccount } from '../../../lib/api'
import { useAuth } from '../../../lib/store'

/**
 * Account deletion (store requirements).
 *
 * Two confirmations in a row, a checkbox and a system dialog: deletion cannot be undone and there
 * is no recovery. The listed consequences match exactly what the server does.
 */

const CONSEQUENCES: Array<{ icon: string; text: string }> = [
  {
    icon: 'text_bubble',
    text: 'Разговоры, память обо мне и всё, что я знал о тебе, стираются у агента безвозвратно.',
  },
  {
    icon: 'person_crop_circle_badge_xmark',
    text: 'Профиль и пароль удаляются. Восстановить аккаунт будет нельзя.',
  },
  {
    icon: 'envelope',
    text: 'Почта освободится: с ней можно будет зарегистрироваться заново — уже как новый человек.',
  },
]

export default function DeleteAccountPage() {
  const { auth, logout } = useAuth()
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)

  async function runDeletion() {
    setLoading(true)
    try {
      await deleteAccount()
      // Sign out before the message: the server will not refresh the token any more, so any
      // background request would fail.
      await logout()
      f7.dialog.alert('Аккаунт и все разговоры удалены. Береги себя.', 'Готово')
    } catch (err) {
      f7.dialog.alert(
        `${apiErrorText(err, { byStatus: { 503: 'Не удалось стереть разговоры — аккаунт на месте' } }, 'Не получилось удалить аккаунт')}. Попробуй чуть позже.`,
        'Удаление не выполнено',
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <Page name="delete-account">
      <Navbar backLink="Профиль" title="Удаление аккаунта" />

      <div className="rd-note rd-note--danger">
        <Icon f7="exclamationmark_triangle_fill" size={20} className="rd-note-icon" />
        <div className="rd-note-body">
          <p className="rd-note-title">Это действие необратимо</p>
          <p className="rd-note-text">
            Удаляется аккаунт <b className="rd-email">{auth.user?.email ?? ''}</b> и всё, что связано с ним.
          </p>
        </div>
      </div>

      <BlockTitle>Что произойдёт</BlockTitle>
      <List inset strong dividers className="rd-menu">
        {CONSEQUENCES.map((item) => (
          <ListItem key={item.icon} className="rd-wrap" title={item.text}>
            <Icon slot="media" f7={item.icon} />
          </ListItem>
        ))}
      </List>

      <List inset strong className="rd-consents" data-testid="consents">
        <ListItem
          checkbox
          checked={confirmed}
          className="rd-wrap"
          title="Я понимаю последствия и хочу удалить аккаунт"
          onChange={(event: ChangeEvent<HTMLInputElement>) => setConfirmed(event.target.checked)}
        />
      </List>

      <Block className="rd-form-actions">
        <Button
          fill
          large
          preloader
          loading={loading}
          disabled={!confirmed || loading}
          className="rd-button-danger"
          onClick={() =>
            f7.dialog.confirm(
              'Аккаунт и все разговоры будут удалены навсегда. Отменить это нельзя.',
              'Удалить аккаунт?',
              () => void runDeletion(),
            )
          }
        >
          Удалить аккаунт
        </Button>
        <p className="rd-fineprint">Передумал(а)? Просто вернись назад — без нажатия кнопки ничего не удаляется.</p>
      </Block>
    </Page>
  )
}
