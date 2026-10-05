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
  description: 'Приложение «Рядом» для Android и iPhone, а также веб-версия в браузере.',
}

/** One way to get the app. The title is an h2 at card scale: a page-section size would not fit half a row. */
function Platform({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <Tile className={className}>
      <h2 className="mb-2 text-[22px] leading-[1.3] font-[650] tracking-display">{title}</h2>
      {/* The last block's bottom margin would pad the card twice. */}
      <div className="[&>:last-child]:mb-0">{children}</div>
    </Tile>
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

        {/* Three panes instead of three bare headings with a hundred pixels between them: the page has little
            to say, and as cards it reads as a set. The browser, the one thing that works today, takes the
            full row; the two stores share the next one. */}
        <div className="mt-8 grid gap-[18px] pb-9 min-[720.02px]:grid-cols-2 min-[1024px]:grid-cols-3 min-[720.02px]:pb-12">
          <Platform title="В браузере" className="min-[720.02px]:max-[1023.9px]:col-span-2">
            <p className="mb-4 text-muted-foreground">
              Ничего ставить не нужно. В Chrome и Safari страницу можно добавить на домашний экран —
              она откроется как обычное приложение и будет работать офлайн.
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
                Сборка для Android готовится. Пока пользуйтесь <span className="whitespace-nowrap">веб-версией</span>.
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
                Сборка для iOS проходит проверку. Пока откройте <span className="whitespace-nowrap">веб-версию</span> в Safari и добавьте её на
                домашний экран: «Поделиться» → «На экран «Домой»».
              </p>
            )}
          </Platform>
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
