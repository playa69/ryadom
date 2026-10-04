import { Badge } from '@ryadom/ui/components/badge'
import { Item, ItemContent, ItemDescription, ItemTitle } from '@ryadom/ui/components/item'
import { cn } from '@ryadom/ui/lib/utils'
import { ChevronRight, ChevronUp } from 'lucide-react'

const MODES = [
  { title: 'Выговориться', hint: 'Просто слушаю, без советов', active: true },
  { title: 'Поболтать', hint: 'Лёгкий разговор ни о чём', active: false },
  { title: 'Вечерний ритуал', hint: 'Дыхание, слова, маленькое действие', active: false },
]

/**
 * The app's home screen as a picture: greeting, the breathing sphere, modes, the input pill. It is
 * decoration only, so the whole thing is hidden from assistive technology.
 */
export function PhoneMock() {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'relative flex w-full max-w-70 flex-col items-stretch gap-4 justify-self-center rounded-[44px] border border-line-strong px-[18px] pt-[22px] pb-5 text-left',
        'bg-linear-180/srgb from-surface/82 to-paper/90 [backdrop-filter:var(--ryadom-blur)]',
        '[box-shadow:var(--ryadom-highlight),var(--ryadom-shadow-2),0_0_100px_rgba(var(--ryadom-indigo-rgb),0.3)]',
        // 360px is the floor: below 400px the mock-up gives up its fixed width.
        'min-[400.02px]:w-[300px] min-[400.02px]:max-w-none min-[1280px]:w-[336px] min-[1280px]:px-[22px] min-[1280px]:pt-6 min-[1280px]:pb-[22px] min-[1600px]:w-[380px]',
      )}
    >
      <div className="flex justify-end">
        <Badge variant="destructive" className="h-auto px-3 py-[5px] text-[12px] font-bold tracking-[0.04em] text-sos">
          SOS
        </Badge>
      </div>

      <div className="grid place-items-center pt-1.5 pb-0.5">
        {/* The same lit core the app draws, with the crisp ring around it. */}
        <div className="orb-core relative size-[150px] animate-orb rounded-full before:absolute before:-inset-3.5 before:rounded-full before:border before:border-brand/50 motion-reduce:animate-none min-[1280px]:size-40 min-[1600px]:size-[190px]" />
      </div>

      <div className="mt-2.5 text-[22px] leading-[1.2] font-[650] tracking-display min-[1280px]:text-[24px]">
        Я рядом. Что сейчас происходит?
      </div>

      <div className="grid gap-2">
        {MODES.map((mode) => (
          <Item
            key={mode.title}
            variant="outline"
            className={cn(
              'relative min-h-0 gap-0 rounded-[18px] py-3 pr-10 pl-4 text-sm leading-[1.6] [box-shadow:var(--ryadom-highlight)]',
              mode.active
                ? 'border-brand-line bg-[linear-gradient(135deg,rgba(var(--ryadom-brand-rgb),0.2),rgba(var(--ryadom-brand-rgb),0.06))]'
                : 'bg-glass',
            )}
          >
            <ItemContent className="gap-px">
              <ItemTitle className="line-clamp-none text-sm leading-[1.6] font-semibold">{mode.title}</ItemTitle>
              <ItemDescription className="line-clamp-none text-xs leading-[1.6] text-balance text-faint">{mode.hint}</ItemDescription>
            </ItemContent>
            <ChevronRight className="absolute top-1/2 right-2 size-5 -translate-y-1/2 text-faint" strokeWidth={2.4} />
          </Item>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 rounded-full border border-line bg-glass-2 py-[7px] pr-[7px] pl-[18px] text-[14px] text-faint">
        <span>Скажи, что на душе…</span>
        <span className="grid size-[38px] shrink-0 place-items-center rounded-full bg-[image:var(--ryadom-cta)] [box-shadow:var(--ryadom-cta-glow)]">
          <ChevronUp className="size-6 text-cta-ink" strokeWidth={2.2} />
        </span>
      </div>
    </div>
  )
}
