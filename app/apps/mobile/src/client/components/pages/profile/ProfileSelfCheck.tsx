import { Block, BlockTitle, Icon, List, ListItem, f7 } from 'framework7-react'
import { useEffect, useState } from 'react'
import { deleteSelfCheckResults, getSelfCheckConsent, revokeSelfCheckConsent } from '../../../lib/api'
import { SELF_CHECK_ENABLED } from '../../../lib/self-check'
import { notify, refreshLatestResults } from '../../../lib/self-check-store'

/**
 * Profile → «Данные»: what is kept of the tests and how to remove it (add-self-check-tests, D5). «Удалить все результаты
 * тестов» removes every saved result; «Отозвать согласие» removes them too and the next saving asks again. Absent with the
 * tests switched off.
 */
export default function ProfileSelfCheck() {
  const [consent, setConsent] = useState<boolean | null>(null)

  useEffect(() => {
    if (!SELF_CHECK_ENABLED) return
    getSelfCheckConsent()
      .then((r) => setConsent(r.given))
      .catch(() => setConsent(null))
  }, [])

  if (!SELF_CHECK_ENABLED || consent === null) return null

  function removeResults() {
    f7.dialog.confirm(
      'Исчезнут результаты всех тестов, история и графики. Согласие на хранение останется, его можно отозвать отдельно.',
      'Удалить все результаты тестов?',
      () => {
        deleteSelfCheckResults()
          .then(() => {
            notify('Все результаты тестов удалены.', 'success')
            refreshLatestResults()
          })
          .catch(() => notify('Не получилось. Повтори ещё раз.', 'error'))
      },
    )
  }

  function revoke() {
    f7.dialog.confirm(
      'Мы удалим все сохранённые результаты тестов и больше не будем их хранить. Пройти тест можно и без сохранения.',
      'Отозвать согласие?',
      () => {
        revokeSelfCheckConsent()
          .then(() => {
            setConsent(false)
            notify('Согласие отозвано, результаты удалены.', 'success')
            refreshLatestResults()
          })
          .catch(() => notify('Не получилось. Повтори ещё раз.', 'error'))
      },
    )
  }

  return (
    <section className="rd-profile-group" data-testid="profile-data">
      <BlockTitle>Данные</BlockTitle>
      <List inset strong className="rd-menu">
        <ListItem link title="Удалить все результаты тестов" className="rd-danger" onClick={removeResults} data-testid="row-delete-self-check">
          <Icon slot="media" f7="trash_fill" />
        </ListItem>
        {consent && (
          <ListItem link title="Отозвать согласие на хранение результатов" className="rd-danger" onClick={revoke} data-testid="row-revoke-self-check">
            <Icon slot="media" f7="lock_fill" />
          </ListItem>
        )}
      </List>
      <Block>
        <p className="rd-caption">Результаты тестов видишь только ты, агент их не читает.</p>
      </Block>
    </section>
  )
}
