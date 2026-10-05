import Link from 'next/link'
import { ArrowLeftIcon } from 'lucide-react'
import type { ComponentProps, FormEvent, ReactNode, RefObject } from 'react'
import { Button } from '@ryadom/ui/components/button'
import { FieldError } from '@ryadom/ui/components/field'
import { Spinner } from '@ryadom/ui/components/spinner'
import { cn } from '@ryadom/ui/lib/utils'
import { FOCUS_RING } from './focus'

/** A refusal shown above the submit button; `field` is the input that should get focus and the red border. */
export interface Problem {
  text: string
  field?: string
}

export function FormError({ problem }: { problem: Problem | null }) {
  if (!problem) return null
  return (
    <FieldError data-testid="form-error" className="text-center leading-[1.4]">
      {problem.text}
    </FieldError>
  )
}

/** Moves focus to a named control of the form, so a refused submit lands where the fix is. */
export function focusField(form: HTMLFormElement | null, name: string | undefined): void {
  if (!form || !name) return
  const control = form.elements.namedItem(name)
  if (control instanceof HTMLElement) control.focus()
}

export function AuthForm({
  formRef,
  onSubmit,
  children,
}: {
  formRef: RefObject<HTMLFormElement | null>
  onSubmit(): void
  children: ReactNode
}) {
  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    onSubmit()
  }

  // method="post": a submit before hydration would otherwise be a GET with the password in the URL.
  return (
    <form
      ref={formRef}
      className="flex flex-col gap-4 [@media(min-width:700px)_and_(max-height:940px)]:gap-3"
      method="post"
      noValidate
      onSubmit={handleSubmit}
    >
      {children}
    </form>
  )
}

/*
 * Tailwind's button reset leaves an arrow cursor, so every button here names the pointer. The primary
 * fill is painted under the transparent border (bg-clip-border), or the button looks a pixel smaller
 * than its box. The outline button names its border color with `!` because the glass surface utility,
 * which comes later in the stylesheet, would otherwise reset it to the faint line. A label may wrap
 * (min height, not a fixed one) so a larger text size never clips it. A text link in a row keeps the
 * full touch height, but drops the border and padding that would push its text over.
 */
const FULL_BUTTON =
  'h-auto min-h-13 w-full cursor-pointer py-3 leading-[1.2] whitespace-normal text-center transition-[filter,transform,scale,background-color,border-color,box-shadow] active:not-aria-[haspopup]:translate-y-0 active:scale-[0.98]'
export const PRIMARY_BUTTON = cn(FULL_BUTTON, 'bg-clip-border hover:brightness-[1.12]', FOCUS_RING)
export const OUTLINE_BUTTON = cn(FULL_BUTTON, 'border-input!', FOCUS_RING)
export const LINK_BUTTON = cn(
  'cursor-pointer border-0 px-0 underline-offset-[3px] hover:brightness-[1.12]',
  FOCUS_RING,
)

/** The refusal, the main button and the secondary actions of a form, stacked. */
export function AuthActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3">{children}</div>
}

/**
 * The form's main button. While `loading` the label stays, so the button does not change width, and
 * a spinner goes in front of it; the press is ignored by pointer-events, not by `disabled`, so focus stays.
 */
export function SubmitButton({ loading, children }: { loading: boolean; children: ReactNode }) {
  return (
    <Button
      type="submit"
      className={cn(PRIMARY_BUTTON, 'aria-busy:pointer-events-none')}
      aria-busy={loading ? 'true' : undefined}
    >
      {loading && (
        <Spinner
          // The label stays in the button, so the spinner is not a separate status for assistive tech.
          role={undefined}
          aria-label={undefined}
          aria-hidden="true"
          strokeWidth={3}
          className="[animation-duration:0.7s] motion-reduce:[animation-duration:2s]"
        />
      )}
      {children}
    </Button>
  )
}

/** Not a button: a way back to the previous step, kept quiet so it does not compete with the form. */
export function BackLink({ href }: { href: string }) {
  return (
    <Button
      asChild
      variant="ghost"
      className={cn(
        'h-11 self-start border-0 px-0 pr-3 text-[0.9375rem] hover:bg-transparent [@media(min-width:700px)_and_(max-height:940px)]:h-9',
        FOCUS_RING,
      )}
    >
      <Link href={href}>
        <ArrowLeftIcon className="size-5" strokeWidth={1.8} />
        Назад
      </Link>
    </Button>
  )
}

/** Secondary text: dim, with the key words (an address, a question) in full white. */
export function Muted({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      className={cn('text-base leading-[1.55] text-muted-foreground [&_b]:text-foreground', className)}
      {...props}
    />
  )
}

export function AuthHead({
  title,
  children,
  badge,
  hideTitle,
}: {
  title: string
  children?: ReactNode
  badge?: ReactNode
  /** The page still needs its h1 for assistive tech, but the screen leads with the brand instead. */
  hideTitle?: boolean
}) {
  return (
    <header className="flex flex-col items-center gap-3 text-center">
      {badge && (
        <span className="mb-1 inline-flex size-[72px] items-center justify-center rounded-full border border-brand-line bg-brand-soft text-brand-400">
          {badge}
        </span>
      )}
      <h1
        className={
          hideTitle
            ? 'sr-only'
            : 'text-[26px] leading-[1.15] font-bold tracking-display-tight text-balance text-foreground'
        }
      >
        {title}
      </h1>
      {children && <Muted className="max-w-[38ch] text-pretty wrap-anywhere">{children}</Muted>}
    </header>
  )
}

/** An address in running text: wrap it as one piece instead of breaking at a hyphen. */
export function Address({ children }: { children: ReactNode }) {
  return <b className="inline-block max-w-full wrap-anywhere">{children}</b>
}

const INLINE_LINK = cn(
  'rounded-sm font-semibold text-brand-400 underline underline-offset-[3px] hover:brightness-[1.12]',
  FOCUS_RING,
)

/** A link inside running text that opens the legal page in its own tab. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className={INLINE_LINK} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

export function FinePrint({ children }: { children: ReactNode }) {
  return <p className="text-center text-xs leading-normal text-faint">{children}</p>
}
