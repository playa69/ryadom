import { cn } from "cn"

/**
 * The breathing sphere, the product's visual anchor: a halo, a lit core and a crisp ring, drawn with
 * Tailwind utilities (orb-glow / orb-core live in globals.css). Size it with `className` (width or
 * `size-*`); the shape is always square. `animated` follows the system reduced-motion setting.
 */
function Orb({
  className,
  animated = true,
  children,
}: {
  className?: string
  animated?: boolean
  /** Optional label centered over the core (the breathing screen's "вдох / выдох"). */
  children?: React.ReactNode
}) {
  return (
    <div
      data-slot="orb"
      aria-hidden={children ? undefined : true}
      className={cn("relative flex aspect-square max-w-full shrink-0 items-center justify-center", className)}
    >
      <span
        className={cn(
          "orb-glow absolute inset-0 rounded-full",
          animated && "animate-breathe motion-reduce:animate-none motion-reduce:scale-95",
        )}
      />
      <span
        className={cn(
          "orb-core absolute inset-[22%] rounded-full",
          animated && "animate-breathe [animation-delay:-0.4s] motion-reduce:animate-none motion-reduce:scale-95",
        )}
      />
      <span
        className={cn(
          "absolute inset-[14%] rounded-full border-[1.5px] border-brand/50",
          animated && "animate-breathe motion-reduce:animate-none motion-reduce:scale-95",
        )}
      />
      {children && <span className="relative text-sm tracking-[0.14em] text-faint uppercase">{children}</span>}
    </div>
  )
}

export { Orb }
