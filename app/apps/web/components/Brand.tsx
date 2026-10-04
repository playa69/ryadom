import { cn } from '@ryadom/ui/lib/utils'

/** The Ryadom mark: a larger and a smaller ring side by side, the small one in blue. */
export function BrandMark({ size = 56, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect x="0.5" y="0.5" width="63" height="63" rx="16" className="fill-surface stroke-line" />
      <circle cx="26" cy="32" r="12" strokeWidth="4" className="fill-none stroke-foreground" />
      <circle cx="43" cy="32" r="7" strokeWidth="4" className="fill-none stroke-brand" />
    </svg>
  )
}

/** Wordmark with the blue dot. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('text-[26px] font-bold tracking-display text-foreground', className)}>
      Рядом<span className="text-brand-400">.</span>
    </span>
  )
}
