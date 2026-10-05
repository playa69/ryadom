/** The favicon motif (two rings), drawn in currentColor so it follows the surrounding text colour. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="8 8 48 48" fill="none" aria-hidden="true" className={className}>
      <circle cx="26" cy="32" r="12" stroke="currentColor" strokeWidth="5" />
      <circle cx="43" cy="32" r="7" stroke="currentColor" strokeOpacity="0.65" strokeWidth="5" />
    </svg>
  )
}
