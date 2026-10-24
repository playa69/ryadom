import { f7 } from 'framework7-react'
import { LinkTelegramApiErrorCode, TelegramLoginApiErrorCode } from '@ryadom/contracts/api/auth/telegram'
import { outcomeFromCode, outcomeFromError, reportForm } from './analytics'
import { apiErrorText, linkTelegram } from './api'
import type { User } from './auth'
import { isTelegramMiniApp, telegramInitData } from './telegram'

/** What the person reads when sign-in with Telegram is refused. */
export function telegramLoginErrorText(code: TelegramLoginApiErrorCode): string {
  switch (code) {
    case TelegramLoginApiErrorCode.INIT_DATA_EXPIRED:
      return 'Telegram просит обновить вход: закрой «Рядом» и открой снова из бота'
    case TelegramLoginApiErrorCode.USER_INACTIVE:
      return 'Этот аккаунт заблокирован'
    case TelegramLoginApiErrorCode.NOT_CONFIGURED:
      return 'Вход через Telegram сейчас недоступен. Войди по почте или попробуй позже'
    case TelegramLoginApiErrorCode.INIT_DATA_INVALID:
    case TelegramLoginApiErrorCode.ACCOUNT_NOT_FOUND:
      return 'Не получилось войти через Telegram. Закрой «Рядом» и открой снова из бота'
  }
}

/**
 * After a sign-in by email inside the Mini App: offers to open this account from Telegram from now on.
 * It asks first, because on someone else's phone this would hand the account to that phone's Telegram.
 * A refusal changes nothing: the person stays signed in by email.
 */
export function offerTelegramLink(user: User, onLinked: () => void): void {
  if (!isTelegramMiniApp() || user.telegramLinked) return
  const initData = telegramInitData()
  if (!initData) return
  f7.dialog
    .create({
      title: 'Входить через Telegram?',
      text: 'Тогда «Рядом» в этом Telegram будет открывать твой аккаунт сразу, без пароля. Не соглашайся, если это чужой телефон.',
      buttons: [
        { text: 'Не сейчас', close: true },
        { text: 'Да', strong: true, close: true, onClick: () => void link(initData, onLinked) },
      ],
    })
    .open()
}

async function link(initData: string, onLinked: () => void): Promise<void> {
  try {
    const outcome = await linkTelegram(initData)
    if (outcome.ok) {
      reportForm('telegram_link', 'success')
      onLinked()
      f7.toast.create({ text: 'Готово: теперь вход через Telegram', closeTimeout: 2500 }).open()
      return
    }
    reportForm('telegram_link', outcomeFromCode(outcome.code))
    const text =
      outcome.code === LinkTelegramApiErrorCode.TELEGRAM_TAKEN
        ? 'Этот Telegram уже открывает другой аккаунт «Рядом»'
        : outcome.code === LinkTelegramApiErrorCode.ALREADY_LINKED
          ? 'К этому аккаунту уже привязан другой Telegram'
          : 'Не получилось привязать Telegram'
    f7.toast.create({ text, closeTimeout: 3000 }).open()
  } catch (error) {
    reportForm('telegram_link', outcomeFromError(error))
    f7.toast
      .create({ text: apiErrorText(error, {}, 'Не получилось привязать Telegram'), closeTimeout: 3000 })
      .open()
  }
}
