import { Item, ItemDescription, ItemTitle } from '@ryadom/ui/components/item'
import { cn } from '@ryadom/ui/lib/utils'
import { BookOpen, Heart, MessageCircle, Mic, Sparkles, Sprout, type LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { connection } from 'next/server'
import { HOTLINES, telHref } from '@/lib/hotlines'
import { getWebEnv } from '@/lib/env'
import { FOCUS_RING, SHELL, SiteFooter, SiteHeader } from './_components/chrome'
import { HomeFaq } from './_components/home-faq'
import {
  CheckItem,
  Checklist,
  COPY,
  CtaButtons,
  Grid,
  H2,
  H3,
  IN_TEXT_LINK,
  PANE,
  Section,
  SectionTitle,
  Step,
  Steps,
  Tag,
  Tile,
} from './_components/home-parts'
import { PhoneMock } from './_components/home-phone'

/** A lit squircle above each mode: a glyph to scan the grid by; the title carries the meaning. */
function ModeMark({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span
      aria-hidden="true"
      className="mb-[18px] grid size-11 place-items-center rounded-[14px] bg-[linear-gradient(145deg,rgba(var(--tint),0.85),rgba(var(--tint),0.28))] text-white [box-shadow:var(--ryadom-highlight),0_8px_24px_-8px_rgba(var(--tint),0.7)]"
    >
      <Icon className="size-[22px]" strokeWidth={2} />
    </span>
  )
}

/**
 * Rendered per request so store and app addresses come from the container's environment rather
 * than the moment of the build: one image for every environment.
 */
export default async function LandingPage() {
  await connection()
  const env = getWebEnv()

  return (
    <>
      <SiteHeader appUrl={env.appUrl} />
      <main className={cn(SHELL, COPY, '[text-rendering:optimizeLegibility]')}>
        <Section
          glow="teal"
          side="left"
          padded={false}
          className={cn(
            'grid grid-cols-1 items-center gap-8 pt-10 pb-12 min-[720.02px]:gap-9 min-[720.02px]:pt-14 min-[720.02px]:pb-18',
            'min-[880.02px]:grid-cols-[1.1fr_0.9fr] min-[880.02px]:gap-12 min-[880.02px]:pt-22 min-[880.02px]:pb-18 min-[1280px]:gap-18 min-[1280px]:pt-18 min-[1280px]:pb-22',
            // A luminous disc behind the phone: the lit anchor of the page.
            'after:pointer-events-none after:absolute after:-z-10 after:top-1/2 after:right-1/2 after:aspect-square after:w-[min(640px,70vw)] after:translate-x-1/2 after:translate-y-[18%] after:rounded-full',
            'after:bg-[radial-gradient(circle,rgba(var(--ryadom-indigo-rgb),0.5)_0,rgba(var(--ryadom-indigo-rgb),0.32)_28%,rgba(var(--ryadom-teal-rgb),0.16)_50%,transparent_72%)]',
            'min-[880.02px]:after:right-[2%] min-[880.02px]:after:translate-x-0 min-[880.02px]:after:-translate-y-1/2',
          )}
        >
          {/* Stacked over the phone on a tablet, the text is centred: left-aligned it would leave the right half of the first screen empty. */}
          <div className="min-[720.02px]:max-[880.02px]:text-center">
            {/* The title fades from white to the dim text tone, so the first line carries the weight. */}
            <h1 className="mb-4 bg-[linear-gradient(180deg,var(--ryadom-text)_40%,var(--ryadom-text-dim)_140%)] bg-clip-text text-[length:clamp(30px,calc((100vw_-_32px)/9.8),56px)] leading-[1.15] font-[650] tracking-display-tight text-balance text-transparent min-[1280px]:text-[length:clamp(56px,4.6vw,64px)]">
              {/* Balancing alone breaks "кто-то" at its hyphen and strands "рядом." on a line of its own. */}
              Когда нужно, чтобы <span className="whitespace-nowrap">кто-то</span> <span className="whitespace-nowrap">был рядом.</span>
            </h1>
            <p className="mb-4 text-[18px] text-dim min-[720.02px]:max-w-[36ch] min-[720.02px]:max-[880.02px]:mx-auto min-[720.02px]:text-[20px] min-[1280px]:text-[21px]">
              Голосовой собеседник, который выслушает в любой момент. Без оценок, без очереди,
              без записи на приём.
            </p>
            <CtaButtons appUrl={env.appUrl} className="min-[720.02px]:max-[880.02px]:justify-center" />
            <p className="mb-4 text-[15px] text-dim">
              Бесплатно на старте. Работает в браузере и на телефоне. 18+
            </p>
          </div>
          <PhoneMock />
        </Section>

        <Section id="honest" glow="indigo" side="right">
          <SectionTitle title="Честно: что это и чем это не является" />
          <Grid cols={2}>
            <Tile>
              <Tag>Это</Tag>
              <H3>Первая опора в тяжёлый момент</H3>
              <p>
                Место, где можно выговориться вслух прямо сейчас: ночью, между делами, когда
                неудобно звонить близким. Разговор помогает назвать то, что происходит, и снизить
                накал.
              </p>
            </Tile>
            <Tile>
              <Tag>Это не</Tag>
              <H3>Психотерапия и не замена людям</H3>
              <p>
                «Рядом» не ставит диагнозов и не лечит. Это мост: разгрузка сейчас и мягкий путь к
                живому контакту — к друзьям, группам поддержки и специалистам.
              </p>
            </Tile>
          </Grid>
        </Section>

        <Section id="scenes" glow="violet" side="left">
          <SectionTitle title="Когда это нужно">Три момента, ради которых всё и делается.</SectionTitle>
          <Grid cols={3}>
            <Tile>
              <Tag>23:40</Tag>
              <H3>Тяжело после ссоры</H3>
              <p>
                Звонить некому, а внутри всё кипит. Проговорить вслух — и стало на один градус
                тише.
              </p>
            </Tile>
            <Tile>
              <Tag>Между встречами</Tag>
              <H3>До следующей группы ещё неделя</H3>
              <p>
                Поддержка нужна не по расписанию. Между встречами есть куда прийти и что сказать.
              </p>
            </Tile>
            <Tile>
              <Tag>Три недели</Tag>
              <H3>Тишина</H3>
              <p>
                Ни с кем толком не говорил. Разговор возвращает привычку говорить о себе вслух — и
                желание написать <span className="whitespace-nowrap">кому-то</span> живому.
              </p>
            </Tile>
          </Grid>
        </Section>

        <Section id="how" glow="indigo" side="right">
          <SectionTitle title="Как это работает">
            Разговор голосом или текстом, как удобнее. Обычно занимает{' '}
            <span className="whitespace-nowrap">5–15 минут</span>.
          </SectionTitle>
          <Steps>
            <Step title="Поговорить">
              Вы говорите — вас слушают до конца, не перебивая и не давая непрошеных советов.
            </Step>
            <Step title="Отражение и называние">
              Собеседник возвращает услышанное своими словами и помогает назвать чувство. Часто
              этого уже достаточно.
            </Step>
            <Step title="Короткое завершение">
              В конце — одна мысль, которую можно унести с собой, и, если хочется, маленький шаг.
            </Step>
            <Step title="Бережное возвращение">
              Разговор заканчивается так, чтобы не бросать посреди тяжёлого: дыхание, пауза,
              возможность продолжить позже.
            </Step>
            <Step title="Люди рядом">
              Когда вы готовы — подсказки, как вернуться к живому общению: кому написать, куда
              прийти, к кому обратиться.
            </Step>
          </Steps>
        </Section>

        <Section id="modes" glow="teal" side="left">
          <SectionTitle title="Режимы разговора">Выбираете в начале; можно поменять в любой момент.</SectionTitle>
          <Grid cols={3}>
            <Tile>
              <ModeMark icon={Mic} />
              <H3>Выговориться</H3>
              <p className="text-dim">Просто выслушают. Без советов и разборов, если вы их не просили.</p>
            </Tile>
            <Tile>
              <ModeMark icon={MessageCircle} />
              <H3>Поболтать</H3>
              <p className="text-dim">Лёгкий разговор ни о чём, когда тяжело молчать в пустой квартире.</p>
            </Tile>
            <Tile>
              <ModeMark icon={BookOpen} />
              <H3>Гештальт-дневник</H3>
              <p className="text-dim">Вопросы, которые помогают увидеть, что с вами происходит и чего вы хотите.</p>
            </Tile>
            <Tile>
              <ModeMark icon={Sprout} />
              <H3>Выздоровление</H3>
              <p className="text-dim">Поддержка тем, кто идёт по программе и держится день за днём.</p>
            </Tile>
            <Tile>
              <ModeMark icon={Sparkles} />
              <H3>Аффирмации и ритуалы</H3>
              <p className="text-dim">Короткие опоры на утро и вечер: дыхание, слова, маленькое действие.</p>
            </Tile>
            <Tile>
              <ModeMark icon={Heart} />
              <H3>Тепло</H3>
              <p className="text-dim">Появится позже: совсем короткие разговоры, когда сил нет вообще.</p>
            </Tile>
          </Grid>
        </Section>

        <Section id="safety" glow="violet" side="right">
          <SectionTitle title="Безопасность">
            Если в разговоре звучит угроза жизни, «Рядом» не продолжает беседу как ни в чём не
            бывало. Разговор останавливается, и на экране появляются телефоны живой помощи.
          </SectionTitle>
          <Checklist>
            <CheckItem lead="Кнопка SOS видна всегда.">
              На любом экране, в один тап, даже без интернета.
            </CheckItem>
            <CheckItem lead="Телефоны зашиты в приложение.">
              Они работают, даже если сервер недоступен.
            </CheckItem>
            <CheckItem lead="Кризисный протокол.">
              В остром состоянии собеседник переходит на короткие фразы и зовёт к людям, а не
              продолжает разговор.
            </CheckItem>
          </Checklist>
          {/* The number leads each card, so the numbers share one line whatever the length of a name, and the
              name and its note read together after it. Three cards across from a laptop; on a tablet each is a
              wide row with the number in a column of its own, so a number never wraps. */}
          <div className="mt-7 grid gap-3 min-[1024px]:grid-cols-3 min-[1024px]:gap-[18px]">
            {HOTLINES.map((hotline) => (
              <Item
                key={hotline.phone}
                variant="outline"
                className={cn(
                  COPY,
                  'glass-2 relative min-h-0 flex-col flex-nowrap items-start gap-y-1 overflow-hidden rounded-lg px-[18px] py-3.5 [box-shadow:var(--ryadom-highlight),var(--ryadom-shadow-1)] min-[720.02px]:px-[22px] min-[720.02px]:py-4',
                  'min-[720.02px]:max-[1024px]:grid min-[720.02px]:max-[1024px]:grid-cols-[13.5rem_1fr] min-[720.02px]:max-[1024px]:items-center min-[720.02px]:max-[1024px]:gap-x-6',
                )}
              >
                <ItemTitle className="line-clamp-none w-auto text-[length:inherit] leading-[inherit] font-normal text-balance">
                  {hotline.name}
                </ItemTitle>
                {/* A bare inline link is only as tall as its text line, about 30px, for the numbers a
                    person in crisis is meant to tap first: min-h gives it a real target. */}
                <a
                  className={cn('order-first inline-flex min-h-11 items-center rounded-sm text-[22px] font-[650] text-brand-400 hover:underline min-[720.02px]:max-[1024px]:row-span-2', FOCUS_RING)}
                  href={telHref(hotline.phone)}
                >
                  {hotline.phone}
                </a>
                <ItemDescription className="line-clamp-none text-sm leading-[1.6] text-balance">{hotline.note}</ItemDescription>
              </Item>
            ))}
          </div>
          <div className={cn(PANE, 'mt-7 rounded-lg px-[18px] py-4 [border-left:3px_solid_var(--ryadom-brand)] min-[720.02px]:px-6 min-[720.02px]:py-5')}>
            <p>
              Если прямо сейчас есть угроза жизни — вашей или чужой — звоните <strong>112</strong>.
              Это быстрее и надёжнее любого приложения.
            </p>
          </div>
        </Section>

        <Section id="privacy" glow="teal" side="left">
          <SectionTitle title="Приватность">
            Разговор о тяжёлом возможен только там, где понятно, что происходит с вашими словами.
          </SectionTitle>
          <Checklist>
            <CheckItem lead="Аудио не хранится.">
              Голос распознаётся на лету и нигде не записывается — ни у нас, ни в приложении.
            </CheckItem>
            <CheckItem lead="Регистрация по почте.">
              Ни имени, ни телефона, ни входа через соцсети. Имя можно выдумать.
            </CheckItem>
            <CheckItem lead="Данные в России.">
              Серверы и база — в РФ, обработка по 152-ФЗ.
            </CheckItem>
            <CheckItem lead="«Стереть всё» одной кнопкой.">
              Удаление аккаунта убирает и разговоры.
            </CheckItem>
            <CheckItem lead="Без рекламы и продажи данных.">
              Разговоры не используются для рекламы.
            </CheckItem>
          </Checklist>
          <p className="mt-5 text-[15px] text-dim">
            Подробности — в{' '}
            <Link className={IN_TEXT_LINK} href="/privacy">
              политике конфиденциальности
            </Link>
            .
          </p>
        </Section>

        <Section id="faq" glow="indigo" side="right">
          <SectionTitle title="Частые вопросы" />
          <HomeFaq />
        </Section>

        <Section glow="violet" side="left">
          <div
            className={cn(
              'relative overflow-hidden rounded-xl border border-line-strong px-5 py-10 text-center shadow-float min-[720.02px]:rounded-2xl min-[720.02px]:px-8 min-[720.02px]:py-16',
              '[background:radial-gradient(70%_90%_at_50%_0%,rgba(var(--ryadom-teal-rgb),0.32),transparent_70%),radial-gradient(60%_80%_at_100%_100%,rgba(var(--ryadom-indigo-rgb),0.4),transparent_70%),var(--ryadom-surface-glass)]',
            )}
          >
            {/* One size at every width, unlike the other section titles. */}
            <H2 className="text-[length:clamp(30px,5vw,44px)] leading-[1.15] min-[1280px]:text-[length:clamp(30px,5vw,44px)] min-[1280px]:leading-[1.15]">
              Попробуйте прямо сейчас
            </H2>
            <p className="text-[18px] text-dim min-[720.02px]:text-[19px] min-[1280px]:text-[21px]">
              Регистрация занимает минуту и требует только почту.
            </p>
            <CtaButtons appUrl={env.appUrl} className="mb-0 justify-center min-[720.02px]:mb-0" />
          </div>
        </Section>
      </main>
      <SiteFooter supportEmail={env.supportEmail} />
    </>
  )
}
