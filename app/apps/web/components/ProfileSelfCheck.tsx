'use client'

import { useEffect, useState } from 'react'
import { useClient } from '@/lib/auth'
import Modal from './Modal'
import { useNotice } from './Notice'
import { Busy, ModalActions, ModalText, ProfileButton, SettingsSection } from './ProfileParts'
import ProfileRow from './ProfileRow'

type Ask = 'results' | 'consent' | null

/**
 * Profile → «Данные»: what is kept of the tests and how to remove it (add-self-check-tests, D5). «Удалить все результаты
 * тестов» removes every saved result; «Отозвать согласие» removes them too and the next saving asks again.
 */
export default function ProfileSelfCheck() {
  const client = useClient()
  const notify = useNotice()
  const [consent, setConsent] = useState<boolean | null>(null)
  const [ask, setAsk] = useState<Ask>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    client
      .getSelfCheckConsent()
      .then((r) => setConsent(r.given))
      .catch(() => setConsent(null))
  }, [client])

  if (consent === null) return null

  async function confirm() {
    setBusy(true)
    try {
      if (ask === 'results') {
        await client.deleteSelfCheckResults()
        notify('Все результаты тестов удалены.', 'success')
      } else {
        await client.revokeSelfCheckConsent()
        setConsent(false)
        notify('Согласие отозвано, результаты удалены.', 'success')
      }
      setAsk(null)
    } catch {
      notify('Не получилось. Повтори ещё раз.', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SettingsSection
        title="Данные"
        testId="profile-data"
        note="Результаты тестов видишь только ты, агент их не читает."
      >
        <li>
          <ProfileRow
            icon="trash"
            label="Удалить все результаты тестов"
            testId="row-delete-self-check"
            danger
            onClick={() => setAsk('results')}
          />
        </li>
        {consent && (
          <li>
            <ProfileRow
              icon="lock"
              label="Отозвать согласие на хранение результатов"
              testId="row-revoke-self-check"
              danger
              onClick={() => setAsk('consent')}
            />
          </li>
        )}
      </SettingsSection>
      <Modal
        open={ask !== null}
        onClose={() => setAsk(null)}
        title={ask === 'consent' ? 'Отозвать согласие?' : 'Удалить все результаты тестов?'}
      >
        <ModalText data-testid="self-check-confirm-text">
          {ask === 'consent'
            ? 'Мы удалим все сохранённые результаты тестов и больше не будем их хранить. Пройти тест можно и без сохранения.'
            : 'Исчезнут результаты всех тестов, история и графики. Согласие на хранение останется, его можно отозвать отдельно.'}
        </ModalText>
        <ModalActions>
          <ProfileButton type="button" variant="outline" onClick={() => setAsk(null)}>
            Отмена
          </ProfileButton>
          <ProfileButton
            type="button"
            variant="danger"
            disabled={busy}
            data-testid="self-check-confirm-yes"
            onClick={() => void confirm()}
          >
            <Busy on={busy} />
            {ask === 'consent' ? 'Отозвать и удалить' : 'Удалить все'}
          </ProfileButton>
        </ModalActions>
      </Modal>
    </>
  )
}
