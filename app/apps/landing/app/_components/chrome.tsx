import Link from 'next/link'
import { Badge } from '@ryadom/ui/components/badge'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'

/*
 * Breakpoints sit 0.02px above the old `max-width` limits (720, 880, 400): browser zoom gives
 * fractional widths, and a `min-width` of the next whole pixel would pick the opposite layout
 * inside that last pixel. 0.02 is the smallest step Chromium still tells apart from the limit,
 * because it truncates media lengths to 1/64px (720.01 would match at exactly 720).
 */

/**
 * The page column. It is wide and its gutter grows with the viewport, so the content neither
 * touches the edge on a tablet nor floats in a void on a wide monitor.
 */
export const SHELL = 'mx-auto max-w-[1320px] px-4 min-[400.02px]:px-[18px] min-[720.02px]:px-[clamp(20px,4vw,48px)]'

/**
 * Keyboard focus: the design's two-tone ring (an inner paper gap, an outer blue band), which reads
 * on the night sky and on the blue fill alike. A single-colour ring vanishes on one of the two.
 */
export const FOCUS_RING =
  'outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper'

/**
 * The lit primary button: it lifts on hover (`translate` has to be in the transition list or it would
 * jump) and its gradient runs under the transparent border, as the button's own edge. A press keeps the
 * hover lift instead of dropping the button a pixel, and the focus ring keeps the glow in its shadow stack.
 */
export const LIT_BUTTON = cn(
  'bg-clip-border transition-[filter,translate,background-color,border-color,box-shadow] hover:-translate-y-px hover:brightness-106 active:not-aria-[haspopup]:-translate-y-px focus-visible:shadow-cta',
  FOCUS_RING,
)

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#00051a" />
      <circle cx="26" cy="32" r="12" fill="none" stroke="#f1f4ff" strokeWidth="4" />
      <circle cx="43" cy="32" r="7" fill="none" stroke="#2e8fff" strokeWidth="4" />
    </svg>
  )
}

const BRAND = cn('inline-flex items-center gap-2.5 rounded-sm text-[18px] font-[650] tracking-display text-foreground', FOCUS_RING)

const NAV_LINK = cn('rounded-sm text-[15px] text-dim hover:text-foreground', FOCUS_RING)

export function SiteHeader({ appUrl }: { appUrl: string }) {
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-paper/55 leading-[1.6] [backdrop-filter:var(--ryadom-blur)]">
      <div className={cn(SHELL, 'flex items-center gap-4 py-3')}>
        <Link className={BRAND} href="/">
          <BrandMark />
          Рядом
        </Link>
        <nav className="ml-auto flex items-center gap-[22px]">
          {/* Two of the three links give way on a phone, so the button keeps its room. */}
          <Link className={cn(NAV_LINK, 'hidden min-[720.02px]:inline')} href="/#safety">
            Безопасность
          </Link>
          <Link className={cn(NAV_LINK, 'hidden min-[720.02px]:inline')} href="/#privacy">
            Приватность
          </Link>
          <Link className={NAV_LINK} href="/download">
            Скачать
          </Link>
          {/* min-h, not h: the button grows with a larger text size instead of clipping it. */}
          <Button asChild className={cn('h-auto min-h-12 px-6 leading-[1.6]', LIT_BUTTON)}>
            <a href={appUrl}>Открыть</a>
          </Button>
        </nav>
      </div>
    </header>
  )
}

const FOOTER_LINK = cn('rounded-sm text-dim hover:text-foreground hover:underline', FOCUS_RING)

export function SiteFooter({ supportEmail }: { supportEmail: string }) {
  return (
    <footer className="border-t border-line pt-8 pb-10 text-[15px] leading-[1.6] text-dim min-[720.02px]:pt-12 min-[720.02px]:pb-14">
      {/* One column on a phone. From a tablet the link columns are as wide as their longest link, so
          "Политика конфиденциальности" never wraps, and the brand takes the rest; from a laptop the
          brand gets twice a link column. The link columns stretch to the brand column's height, so
          their rows are packed at the top (content-start) instead of drifting apart. */}
      <div
        className={cn(
          SHELL,
          'grid gap-7 min-[720.02px]:grid-cols-[minmax(0,1fr)_max-content_max-content] min-[720.02px]:gap-x-10 min-[1024px]:grid-cols-[minmax(0,2fr)_minmax(max-content,1fr)_minmax(0,1fr)] min-[1024px]:gap-x-12',
        )}
      >
        <div>
          <Link className={BRAND} href="/">
            <BrandMark size={24} />
            Рядом
          </Link>
          <p className="mt-3 mb-4 max-w-[38ch] text-[15px]">
            Голосовой собеседник для эмоциональной разгрузки. Не медицинская услуга и не замена
            психотерапии.
          </p>
          <Badge variant="outline" className="size-[34px] rounded-[10px] border-input p-0 text-[13px] font-semibold text-dim">
            18+
          </Badge>
        </div>
        <nav className="grid content-start gap-2">
          <strong className="font-medium text-foreground">Документы</strong>
          <Link className={FOOTER_LINK} href="/privacy">
            Политика конфиденциальности
          </Link>
          <Link className={FOOTER_LINK} href="/terms">
            Пользовательское соглашение
          </Link>
          <Link className={FOOTER_LINK} href="/delete-account">
            Удаление аккаунта и данных
          </Link>
        </nav>
        <nav className="grid content-start gap-2">
          <strong className="font-medium text-foreground">Связь</strong>
          <a className={FOOTER_LINK} href={`mailto:${supportEmail}`}>
            {supportEmail}
          </a>
          <Link className={FOOTER_LINK} href="/download">
            Приложения
          </Link>
        </nav>
      </div>
    </footer>
  )
}
