import { Orb } from '@ryadom/ui/components/orb'
import { cn } from '@ryadom/ui/lib/utils'

/**
 * The product's breathing sphere (the shared Orb): four seconds in, four out, pure CSS. The size is
 * a class, not an inline style, because the CSP forbids server-rendered `style=""`; a screen passes
 * its own width in `className` (the last width class wins).
 */
export default function Breathing({ label, className }: { label?: string; className?: string }) {
  return (
    <Orb
      // Orb freezes its three layers at 95% for reduced motion; the product has always frozen them at 96%.
      className={cn('w-[120px]', 'motion-reduce:[&>.absolute]:scale-[0.96]', className)}
    >
      {label}
    </Orb>
  )
}
