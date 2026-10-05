import { cn } from '@ryadom/ui/lib/utils'
import { Minus, Plus } from 'lucide-react'
import Link from 'next/link'
import { FOCUS_RING } from './chrome'
import { COPY, IN_TEXT_LINK, PANE } from './home-parts'

/*
 * Native <details>, not the Accordion: it opens without JavaScript, every answer stays in the
 * server-rendered HTML for search engines, and nothing renders an inline style (the web app's
 * CSP would reject one). Each question is an independent disclosure.
 */
function Faq({ question, children }: { question: string; children: React.ReactNode }) {
  return (
    <details className={cn(PANE, 'group rounded-lg px-5.5 py-1')}>
      <summary
        className={cn(
          'relative cursor-pointer list-none rounded-md py-4 pr-9 text-[17px] leading-[1.6] font-semibold min-[720.02px]:text-lg [&::-webkit-details-marker]:hidden',
          FOCUS_RING,
        )}
      >
        {question}
        {/* The open/closed mark is a plus and a minus, not a chevron. */}
        <span aria-hidden="true" className="absolute top-1/2 right-0 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-brand-soft text-brand-400">
          <Plus className="size-[15px] translate-y-px group-open:hidden" strokeWidth={3} />
          <Minus className="hidden size-[15px] translate-y-px group-open:block" strokeWidth={3} />
        </span>
      </summary>
      <div className="mb-4 max-w-[68ch] text-dim min-[1280px]:max-w-[72ch]">{children}</div>
    </details>
  )
}

export function HomeFaq() {
  return (
    <div className={cn(COPY, 'mt-6 flex flex-col gap-3')}>
      <Faq question="Это терапия?">
        <p>
          Нет. «Рядом» не оказывает медицинских и психотерапевтических услуг, не ставит диагнозов и
          не назначает лечение. Это поддержка в моменте и помощь в том, чтобы дойти до живых людей
          и специалистов.
        </p>
      </Faq>
      <Faq question="Кто видит мои разговоры?">
        <p>
          Никто из сотрудников не читает переписки в обычной работе. Аудио не сохраняется вовсе.
          Текст разговора нужен, чтобы вы могли вернуться к нему в журнале, и удаляется вместе с
          аккаунтом.
        </p>
      </Faq>
      <Faq question="Сколько это стоит?">
        <p>
          Сейчас бесплатно. Если появится платная часть, бесплатным останется то, что касается
          безопасности: SOS, телефоны помощи и возможность выговориться.
        </p>
      </Faq>
      <Faq question="Как удалить всё?">
        <p>
          В приложении: «Профиль» → «Удалить аккаунт». Аккаунт и разговоры стираются, восстановить
          их нельзя. Подробнее — на странице{' '}
          <Link className={IN_TEXT_LINK} href="/delete-account">
            удаления аккаунта
          </Link>
          .
        </p>
      </Faq>
      <Faq question="А если мне станет хуже во время разговора?">
        <p>
          Разговор можно прервать в любой момент. Кнопка SOS с телефонами живой помощи видна на
          каждом экране, и она работает даже без интернета.
        </p>
      </Faq>
    </div>
  )
}
