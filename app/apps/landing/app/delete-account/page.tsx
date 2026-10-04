import type { Metadata } from 'next'
import { connection } from 'next/server'
import { getWebEnv } from '@/lib/env'
import { SiteFooter, SiteHeader } from '../_components/chrome'
import {
  Lead,
  LegalDocument,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../_doc/doc'

export const metadata: Metadata = {
  title: 'Удаление аккаунта «Рядом»',
  description: 'Как удалить аккаунт «Рядом» и что именно стирается.',
}

/**
 * A public page reachable without the app, required by Google Play and App Store: the store
 * listing links here, so it must describe the steps and name exactly what is erased and what is
 * kept.
 */
export default async function DeleteAccountPage() {
  await connection()
  const env = getWebEnv()

  return (
    <>
      <SiteHeader appUrl={env.appUrl} />
      <LegalDocument>
        <h1>Удаление аккаунта и данных</h1>
        <Lead>
          Аккаунт удаляется из самого приложения, без писем и обращений в поддержку. Это
          необратимо.
        </Lead>

        <h2>Как удалить</h2>
        <ol>
          <li>Откройте приложение «Рядом» и войдите в аккаунт.</li>
          <li>Перейдите на вкладку «Профиль».</li>
          <li>Нажмите «Стереть всё и удалить аккаунт».</li>
          <li>Отметьте «Я понимаю последствия» и подтвердите удаление в появившемся окне.</li>
        </ol>
        <p>
          То же самое доступно в веб-версии: <a href={env.appUrl}>{env.appUrl}</a>.
        </p>

        <h2>Что стирается сразу</h2>
        <ul>
          <li>Ваши разговоры и их тексты, включая журнал.</li>
          <li>Имя и любые данные профиля.</li>
          <li>Почта и пароль: войти под этим аккаунтом больше нельзя.</li>
          <li>Все активные сессии на всех устройствах.</li>
        </ul>
        <p>
          Аудиозаписей не остаётся, потому что их не существует: голос распознаётся на лету и
          нигде не сохраняется.
        </p>

        <h2>Что остаётся и почему</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Что</TableHead>
              <TableHead>Зачем</TableHead>
              <TableHead>Насколько</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell data-label="Что">Обезличенная запись о самом факте удаления</TableCell>
              <TableCell data-label="Зачем">Подтвердить, что обращение исполнено</TableCell>
              <TableCell data-label="Насколько">Без вашей почты, имени и содержания разговоров</TableCell>
            </TableRow>
            <TableRow>
              <TableCell data-label="Что">Технические журналы серверов</TableCell>
              <TableCell data-label="Зачем">Расследование сбоев и инцидентов безопасности</TableCell>
              <TableCell data-label="Насколько">До 30 дней, затем удаляются</TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <h2>Если войти не получается</h2>
        <p>
          Напишите с той же почты на <a href={`mailto:${env.supportEmail}`}>{env.supportEmail}</a>.
          Мы удалим аккаунт вручную. Ответ занимает до 30 дней, обычно быстрее.
        </p>
      </LegalDocument>
      <SiteFooter supportEmail={env.supportEmail} />
    </>
  )
}
