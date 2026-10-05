import type { Metadata } from 'next'
import Link from 'next/link'
import { connection } from 'next/server'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { getWebEnv } from '@/lib/env'
import { SiteFooter, SiteHeader } from '../_components/chrome'
import { Tile } from '../_components/home-parts'
import {
  ButtonRow,
  inlineLink,
  Lead,
  PageMain,
  PageTitle,
  pageButton,
  pageButtonLift,
  pageButtonOutline,
} from '../_doc/doc'

export const metadata: Metadata = {
  title: 'Скачать «Рядом»',
  description:
    'Приложение «Рядом» для Android и iPhone, веб-версия в браузере и установка из браузера без магазина.',
}

/** One way to get the app. The title is an h2 at card scale: a page-section size would not fit half a row. */
function Platform({
  title,
  id,
  className,
  children,
}: {
  title: string
  /** An anchor for links from the other cards. */
  id?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <Tile className={className}>
      <h2 id={id} className="mb-2 text-[22px] leading-[1.3] font-[650] tracking-display">
        {title}
      </h2>
      {/* The last block's bottom margin would pad the card twice. */}
      <div className="[&>:last-child]:mb-0">{children}</div>
    </Tile>
  )
}

/** One install recipe: browsers differ, so each kind of device gets its own steps. */
function InstallSteps({ title, steps }: { title: string; steps: React.ReactNode[] }) {
  return (
    <div>
      <h3 className="mb-2 text-[16px] leading-[1.4] font-[650]">{title}</h3>
      <ol className="list-decimal space-y-1.5 pl-5 text-[15px] text-muted-foreground">
        {steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
    </div>
  )
}

/** Store buttons appear only for stores where the app is actually published. */
export default async function DownloadPage() {
  await connection()
  const env = getWebEnv()

  return (
    <>
      <SiteHeader appUrl={env.appUrl} />
      <PageMain>
        <div className="max-w-[720px]">
          <PageTitle>Скачать «Рядом»</PageTitle>
          <Lead>
            Приложение работает и в браузере, и на телефоне. Аккаунт один: где бы вы ни вошли, это
            те же разговоры.
          </Lead>
        </div>

        {/* Panes instead of bare headings with a hundred pixels between them: the page has little to say, and
            as cards it reads as a set. The browser, the one thing that works today, takes the full row; the
            two stores share the next one; the install-from-browser instructions are the last, full-width
            pane (shown only when the PWA address is configured). */}
        <div className="mt-8 grid gap-[18px] pb-9 min-[720.02px]:grid-cols-2 min-[1024px]:grid-cols-3 min-[720.02px]:pb-12">
          <Platform title="В браузере" className="min-[720.02px]:max-[1023.9px]:col-span-2">
            <p className="mb-4 text-muted-foreground">
              Ничего ставить не нужно: откройте «Рядом» в браузере на телефоне или на компьютере и
              войдите в свой аккаунт.
            </p>
            <ButtonRow className="mt-6">
              <Button asChild className={cn(pageButton, pageButtonLift)}>
                <a href={env.appUrl}>Открыть в браузере</a>
              </Button>
            </ButtonRow>
          </Platform>

          <Platform title="Android">
            {env.rustoreUrl || env.googlePlayUrl || env.androidApkUrl ? (
              <ButtonRow className="mt-4">
                {env.rustoreUrl && (
                  <Button asChild className={cn(pageButton, pageButtonLift)}>
                    <a href={env.rustoreUrl}>RuStore</a>
                  </Button>
                )}
                {env.googlePlayUrl && (
                  <Button asChild variant="outline" className={cn(pageButton, pageButtonOutline)}>
                    <a href={env.googlePlayUrl}>Google Play</a>
                  </Button>
                )}
                {env.androidApkUrl && (
                  <Button asChild variant="outline" className={cn(pageButton, pageButtonOutline)}>
                    <a href={env.androidApkUrl}>Скачать APK</a>
                  </Button>
                )}
              </ButtonRow>
            ) : (
              <p className="mb-4 text-muted-foreground">
                Сборка для Android готовится. Пока пользуйтесь <span className="whitespace-nowrap">веб-версией</span>
                {env.pwaUrl && (
                  <>
                    {' '}
                    или{' '}
                    <a className={inlineLink} href="#install">
                      установите «Рядом» из браузера
                    </a>
                  </>
                )}
                .
              </p>
            )}
            {env.androidApkUrl && (
              <p className="mb-4 text-[15px] text-muted-foreground">
                APK ставится в обход магазина: Android спросит разрешение на установку из этого
                источника. Обновления такой сборки придётся ставить вручную.
              </p>
            )}
          </Platform>

          <Platform title="iPhone и iPad">
            {env.appStoreUrl ? (
              <ButtonRow className="mt-4">
                <Button asChild className={cn(pageButton, pageButtonLift)}>
                  <a href={env.appStoreUrl}>App Store</a>
                </Button>
              </ButtonRow>
            ) : (
              <p className="mb-4 text-muted-foreground">
                Сборка для iOS проходит проверку. Пока откройте <span className="whitespace-nowrap">веб-версию</span> в Safari
                {env.pwaUrl && (
                  <>
                    {' '}
                    или{' '}
                    <a className={inlineLink} href="#install">
                      установите «Рядом» на домашний экран
                    </a>
                  </>
                )}
                .
              </p>
            )}
          </Platform>

          {env.pwaUrl && (
            <Platform title="Установить из браузера" id="install" className="min-[720.02px]:col-span-full">
              <p className="mb-5 text-muted-foreground">
                Без магазина приложений: «Рядом» появится на домашнем экране и будет открываться в
                отдельном окне, как обычное приложение. Аккаунт тот же, для разговоров нужен интернет.
              </p>
              <div className="grid gap-6 min-[720.02px]:grid-cols-3">
                <InstallSteps
                  title="Android, Chrome"
                  steps={[
                    'Откройте «Рядом» кнопкой ниже.',
                    'Нажмите «Установить» в плашке внизу экрана. Если её нет, откройте меню браузера (три точки) и выберите «Установить приложение» или «Добавить на главный экран».',
                    'Подтвердите: значок «Рядом» появится на домашнем экране.',
                  ]}
                />
                <InstallSteps
                  title="iPhone и iPad, Safari"
                  steps={[
                    'Откройте «Рядом» кнопкой ниже именно в Safari: из встроенных браузеров мессенджеров и других приложений установить не получится.',
                    'Нажмите «Поделиться» и выберите «На экран «Домой»».',
                    'Нажмите «Добавить».',
                  ]}
                />
                <InstallSteps
                  title="Компьютер, Chrome или Edge"
                  steps={[
                    'Откройте «Рядом» кнопкой ниже.',
                    'Нажмите значок установки справа в адресной строке или выберите в меню браузера пункт установки приложения.',
                    'Подтвердите: «Рядом» откроется в отдельном окне.',
                  ]}
                />
              </div>
              <ButtonRow className="mt-6">
                <Button asChild className={cn(pageButton, pageButtonLift)}>
                  <a href={env.pwaUrl}>Открыть и установить</a>
                </Button>
              </ButtonRow>
            </Platform>
          )}
        </div>

        <p className="text-[15px] text-muted-foreground">
          Не получается установить? Напишите на{' '}
          <a className={inlineLink} href={`mailto:${env.supportEmail}`}>
            {env.supportEmail}
          </a>
          . Что стирается при удалении аккаунта — на странице{' '}
          <Link className={inlineLink} href="/delete-account">
            удаления
          </Link>
          .
        </p>
      </PageMain>
      <SiteFooter supportEmail={env.supportEmail} />
    </>
  )
}
