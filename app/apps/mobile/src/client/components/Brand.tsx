/**
 * The Ryadom mark: two shapes side by side, one larger and one smaller, with a warm glow between
 * them. The landing page and the app icon use the same mark.
 */
export function BrandMark({ size = 56, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect x="0.5" y="0.5" width="63" height="63" rx="16" fill="#00051a" stroke="rgba(255,255,255,0.1)" />
      <circle cx="26" cy="32" r="12" fill="none" stroke="#f1f4ff" strokeWidth="4" />
      <circle cx="43" cy="32" r="7" fill="none" stroke="#2e8fff" strokeWidth="4" />
    </svg>
  )
}
