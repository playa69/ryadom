import * as React from "react"
import { cn } from "cn"
import { CheckIcon } from "lucide-react"

/**
 * A checkbox that is a real `<input type="checkbox">`, drawn like the shadcn Checkbox. Radix's Checkbox
 * renders a hidden input with an inline `style` on the server, which a page with a strict
 * Content-Security-Policy refuses; this one is for a checkbox inside a form on such a page. The native
 * input also keeps the name, `required` and the checkbox role working before the page hydrates.
 * Wrap it in a `<label>` or give it an id and a Label.
 */
function NativeCheckbox({
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <span className="relative flex size-6 shrink-0">
      <input
        type="checkbox"
        data-slot="checkbox"
        className={cn(
          // 8px corners: this theme's rounded-md is 16px, which would turn a 24px box into a circle.
          "peer size-6 cursor-pointer appearance-none rounded-[8px] border-2 border-input bg-surface transition-colors outline-none checked:border-primary checked:bg-primary focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 forced-colors:checked:border-[Highlight] forced-colors:checked:bg-[Highlight] forced-colors:checked:forced-color-adjust-none",
          className
        )}
        {...props}
      />
      {/* A heavy stroke, as the native tick was; in forced-colors the fill is Highlight, so the tick is HighlightText. */}
      <CheckIcon
        aria-hidden="true"
        strokeWidth={3.75}
        className="pointer-events-none absolute inset-0 m-auto size-4 text-primary-foreground opacity-0 peer-checked:opacity-100 forced-colors:text-[HighlightText] forced-colors:forced-color-adjust-none"
      />
    </span>
  )
}

export { NativeCheckbox }
