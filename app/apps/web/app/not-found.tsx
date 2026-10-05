import Link from 'next/link'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { BUTTON } from '@/components/controls'

// Own page rather than Next's default: that one is English, white and styled with inline `style`
// attributes, which the strict CSP blocks. It sits outside both the shell and the (auth) frame, so
// it carries its own safe-area padding and side gutters (16px, 32px from 700px, 40px from 1024px).
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 pt-[calc(env(safe-area-inset-top,0px)+40px)] pr-[calc(16px+env(safe-area-inset-right,0px))] pb-[calc(env(safe-area-inset-bottom,0px)+40px)] pl-[calc(16px+env(safe-area-inset-left,0px))] text-center tab:pr-[calc(32px+env(safe-area-inset-right,0px))] tab:pl-[calc(32px+env(safe-area-inset-left,0px))] desk:pr-[calc(40px+env(safe-area-inset-right,0px))] desk:pl-[calc(40px+env(safe-area-inset-left,0px))]">
      <h1 className="text-[26px] leading-[1.15] font-bold tracking-display-tight text-balance text-foreground">
        Такой страницы нет
      </h1>
      <p className="text-base leading-[1.55] text-dim">Возможно, ссылка устарела. Начни с главной.</p>
      <Button asChild className={cn(BUTTON, 'bg-clip-border px-6 leading-[1.2] hover:brightness-[1.12] focus-visible:border-transparent')}>
        <Link href="/home">На главную</Link>
      </Button>
    </main>
  )
}
