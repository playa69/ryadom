import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@ryadom/ui/lib/utils'
import { AppHeader } from './AppHeader'

/**
 * How wide the content of a page may get. `reading` is the width of the chat column, so a saved
 * transcript lines up with the live conversation; `list` is for rows of settings and help lines;
 * `form` is for one short form or one decision.
 */
const MEASURE = {
  reading: 'max-w-180',
  list: 'max-w-2xl',
  form: 'max-w-120',
} as const

/** The small quiet heading over a group of rows ("Сегодня", "Безопасность"). */
export const SECTION_HEADING = 'px-1 text-[0.8125rem] leading-5 font-semibold tracking-[0.02em] text-faint'

/**
 * A page that is not a chat: the shared header, then one centered column. The header carries the h1
 * and, for sub-pages, the way back. The container around the page has no padding, so the gutters (with
 * the side insets of a phone on its side, `viewportFit: cover`) and the bottom inset (the phone's home
 * bar) are set here. Extra props land on the column.
 */
export function Page({
  title,
  back,
  actions,
  measure = 'list',
  className,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> &
  Pick<ComponentProps<typeof AppHeader>, 'title' | 'back'> & {
    actions?: ReactNode
    measure?: keyof typeof MEASURE
  }) {
  return (
    <>
      <AppHeader title={title} back={back} actions={actions} />
      <div className="flex-1 pt-6 pr-[max(1rem,env(safe-area-inset-right,0px))] pb-[calc(2rem+env(safe-area-inset-bottom,0px))] pl-[max(1rem,env(safe-area-inset-left,0px))] tab:pt-10 tab:pr-[max(1.5rem,env(safe-area-inset-right,0px))] tab:pb-14 tab:pl-[max(1.5rem,env(safe-area-inset-left,0px))]">
        <div
          className={cn('mx-auto flex w-full min-w-0 flex-col gap-6', MEASURE[measure], className)}
          {...props}
        >
          {children}
        </div>
      </div>
    </>
  )
}
