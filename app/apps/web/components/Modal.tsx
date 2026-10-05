'use client'

import { useRef, type ReactNode } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@ryadom/ui/components/dialog'
import { cn } from '@ryadom/ui/lib/utils'

export interface ModalProps {
  open: boolean
  onClose(): void
  title: string
  children: ReactNode
  /** Backdrop click and Esc close it. Set false for a step that must be answered explicitly. */
  dismissible?: boolean
  /** Extra classes on the dialog element, e.g. to cap the width. They win over the defaults here. */
  className?: string
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * The shared sheet on shadcn's Dialog (Radix): bottom sheet on phones, centered pane from 700px.
 * Content is mounted only while open, so heavy children do no work when closed.
 */
export default function Modal({ open, onClose, title, children, dismissible = true, className }: ModalProps) {
  // Radix returns focus to a <Trigger>; this sheet is opened from anywhere, so remember the opener.
  const opener = useRef<HTMLElement | null>(null)

  return (
    <Dialog
      open={open}
      // React stays the source of truth: the sheet closes only through the `open` prop. A step that
      // must be answered explicitly ignores Esc and the backdrop, and the prop keeps it open.
      onOpenChange={(next) => {
        if (!next && dismissible) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        // No description element: the title names the sheet. An explicit undefined also silences Radix's dev warning.
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          // Radix passes over links when it picks the first control; the native <dialog> this replaced took
          // the first focusable one in order, links included (the SOS sheet opens on its first help line).
          const first = [...(event.target as HTMLElement).querySelectorAll<HTMLElement>(FOCUSABLE)].find(
            (el) => el.getClientRects().length > 0,
          )
          if (first) {
            event.preventDefault()
            first.focus()
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (opener.current?.isConnected) opener.current.focus()
        }}
        className={cn(
          'grid-cols-1 gap-3 overscroll-contain rounded-t-xl px-5 pt-6 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] tab:rounded-xl',
          // `glass-2` sets its own box-shadow, which the base `shadow-float` loses to; a variant wins.
          'tab:shadow-float max-tab:shadow-[var(--ryadom-highlight),0_-12px_40px_rgb(0_0_0/0.4)]',
          // The slide-in is motion: people who ask for less get the sheet without it.
          'motion-reduce:data-closed:animate-none motion-reduce:data-open:animate-none',
          // A phone on its side: the sheet may use the whole height, and gives some of its padding back.
          'short:max-h-[calc(100dvh-16px)] short:gap-2 short:px-5 short:pt-3 short:pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]',
          className,
        )}
      >
        <DialogTitle className="text-[22px] leading-tight tracking-normal short:text-[19px]">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  )
}
