'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import { cn } from '@ryadom/ui/lib/utils'
import BootSplash from '@/components/BootSplash'
import { BrandMark, Wordmark } from '@/components/Brand'
import { useNoticePlacement } from '@/components/Notice'
import { useAuth } from '@/lib/auth'
import { AuthFlowProvider } from './auth-flow'

/**
 * Anonymous screens. Phone: the form sits straight on the ambient background. From 700px it moves
 * into a glass card centered in the viewport; the brand stays above it. Nothing here has a fixed
 * width: columns use max-width so nothing overflows at 360px.
 */
export default function AuthFrame({ webUrl, children }: { webUrl: string; children: ReactNode }) {
  const { status } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  // No sidebar on these screens, so toasts center on the window.
  useNoticePlacement('bare')

  // The first screen is also where a signed-in person lands when the terms need agreeing to again;
  // it decides for itself when to move on. On every other screen a session means "go home".
  const keepsSignedIn = pathname === '/welcome'

  // Every sign-in path ends here: the screens do not navigate after a successful sign-in themselves.
  useEffect(() => {
    if (status === 'authenticated' && !keepsSignedIn) router.replace('/home')
  }, [status, keepsSignedIn, router])

  if (status === 'authenticated' && !keepsSignedIn) return <BootSplash />

  // Phone, secondary screens: the brand shrinks to a single line so the form gets the height. The
  // first screens of a visit (this one and the sign-in) lead with the brand and the sphere.
  const leading = pathname === '/login' || pathname === '/welcome'
  const compact = !leading

  return (
    <AuthFlowProvider webUrl={webUrl}>
      <div className="flex min-h-dvh flex-col items-center pt-[calc(env(safe-area-inset-top,0px)+clamp(24px,4vh,56px))] pr-[calc(20px+env(safe-area-inset-right,0px))] pb-[calc(env(safe-area-inset-bottom,0px)+clamp(24px,4vh,56px))] pl-[calc(20px+env(safe-area-inset-left,0px))] [@media(min-width:700px)_and_(max-height:940px)]:pt-4 [@media(min-width:700px)_and_(max-height:940px)]:pb-4">
        {/* Auto margins center the block when it fits and let the page scroll when it does not. */}
        <div className="flex w-full max-w-[440px] min-w-0 flex-col gap-6 tab:my-auto tab:max-w-[480px] tab:gap-8 min-[1440px]:max-w-[520px] [@media(min-width:700px)_and_(max-height:940px)]:gap-4">
          {leading && (
            // The sphere from the home screen, small: a lit presence above the sign-in form. The form
            // must stay on screen, so with little height to spare the sphere gives way.
            <div
              aria-hidden="true"
              className="orb-core relative -mb-2 aspect-square w-[104px] animate-orb self-center rounded-full before:absolute before:-inset-2.5 before:rounded-full before:border before:border-brand/45 motion-reduce:animate-none [@media(max-height:740px)]:hidden [@media(min-width:700px)_and_(max-height:900px)]:hidden"
            />
          )}
          {/* A landscape phone has almost no height, and neither has a laptop screen: the mark and the
              wordmark go side by side there so the form fits without scrolling. */}
          <div
            className={cn(
              'flex flex-col items-center justify-center gap-3 [@media(max-height:520px)_and_(orientation:landscape)]:flex-row [@media(min-width:700px)_and_(max-height:940px)]:flex-row',
              compact && 'max-tab:flex-row max-tab:gap-2',
            )}
          >
            <BrandMark
              size={56}
              className={cn(compact && 'max-tab:size-8', '[@media(min-width:700px)_and_(max-height:940px)]:size-10')}
            />
            <Wordmark className={compact ? 'max-tab:text-[22px]' : undefined} />
          </div>
          <main className="flex min-w-0 flex-col gap-6 [@media(min-width:700px)_and_(max-height:940px)]:gap-4 tab:glass tab:rounded-2xl tab:p-[clamp(24px,4vw,40px)] tab:[box-shadow:var(--ryadom-highlight),var(--ryadom-shadow-2)] [@media(min-width:700px)_and_(max-height:940px)]:p-6">
            {children}
          </main>
        </div>
      </div>
    </AuthFlowProvider>
  )
}
