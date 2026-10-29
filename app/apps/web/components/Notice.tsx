'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cn } from '@ryadom/ui/lib/utils'

/**
 * Short, non-blocking messages ("Сохранено"). Errors that need an action belong in the screen.
 *
 * Not sonner on purpose: it injects a <style> without the page's nonce and renders `style=""`, and
 * the strict CSP of this app forbids both.
 */

type NoticeKind = 'info' | 'success' | 'error'

/**
 * Where the stack sits depends on the chrome around the screen: at the bottom of the page beside the
 * sidebar (the default), under a screen's own top bar, or with no chrome at all. The chrome says so
 * through useNoticePlacement instead of the stylesheet guessing from sibling selectors.
 */
export type NoticePlacement = 'shell' | 'top' | 'bare'

interface NoticeItem {
  id: number
  text: string
  kind: NoticeKind
}

const NoticeContext = createContext<((text: string, kind?: NoticeKind) => void) | null>(null)
const PlacementContext = createContext<(placement: NoticePlacement) => void>(() => {})

const LIFETIME_MS = 4000

/** The border tone is the only thing that tells the kinds apart. */
const KIND_BORDER: Record<NoticeKind, string> = {
  info: 'border-input',
  success: 'border-sage-line',
  // An error is the same toast as a success, in red: a red border and a red wash under the text.
  error: 'border-danger-line bg-danger-soft',
}

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<NoticeItem[]>([])
  const [placement, setPlacement] = useState<NoticePlacement>('shell')
  const nextId = useRef(1)

  const notify = useCallback((text: string, kind: NoticeKind = 'info') => {
    const id = nextId.current++
    setItems((prev) => [...prev.slice(-2), { id, text, kind }])
    window.setTimeout(() => setItems((prev) => prev.filter((item) => item.id !== id)), LIFETIME_MS)
  }, [])

  return (
    <NoticeContext.Provider value={notify}>
      <PlacementContext.Provider value={setPlacement}>{children}</PlacementContext.Provider>
      {/* The live region exists from the start; a region inserted together with its text is often not announced. */}
      <div
        className={cn(
          // Default ("shell"): the bottom edge of the phone's page; from 768px the sidebar owns the left column,
          // so the stack centers on the page beside it, which is half the sidebar's width past the middle
          // (16rem open, 3rem as an icon rail). This provider sits above the sidebar, so the rail is read off the DOM.
          'pointer-events-none fixed bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] left-1/2 z-100 flex w-[min(92vw,420px)] -translate-x-1/2 flex-col gap-2',
          'md:bottom-6 md:left-[calc(50%+8rem)] [body:has([data-slot=sidebar][data-state=collapsed])_&]:md:left-[calc(50%+1.5rem)]',
          // The placements are more specific than the breakpoints above, so they win at every width.
          'data-[place=top]:top-[calc(env(safe-area-inset-top,0px)+76px)] data-[place=top]:bottom-auto',
          'data-[place=bare]:bottom-[calc(env(safe-area-inset-bottom,0px)+24px)] data-[place=bare]:left-1/2',
        )}
        data-place={placement}
        role="status"
        aria-live="polite"
      >
        {items.map((item) => (
          <p
            key={item.id}
            data-testid="notice"
            data-kind={item.kind}
            className={cn(
              'rounded-lg border bg-surface-3 px-4 py-3 text-center text-[0.9375rem] text-foreground shadow-(--ryadom-shadow-2)',
              KIND_BORDER[item.kind],
            )}
          >
            {item.text}
          </p>
        ))}
      </div>
    </NoticeContext.Provider>
  )
}

/** `const notify = useNotice(); notify('Сохранено', 'success')` */
export function useNotice() {
  const notify = useContext(NoticeContext)
  if (!notify) throw new Error('useNotice must be used inside NoticeProvider')
  return useMemo(() => notify, [notify])
}

/** Called by a layout or screen for as long as it is mounted; the stack goes back to the default after. */
export function useNoticePlacement(placement: NoticePlacement) {
  const setPlacement = useContext(PlacementContext)
  useEffect(() => {
    setPlacement(placement)
    return () => setPlacement('shell')
  }, [placement, setPlacement])
}
