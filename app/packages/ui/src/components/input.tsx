import * as React from "react"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-13 w-full min-w-0 rounded-lg border border-input bg-glass px-4 py-1 text-base shadow-card transition-colors outline-hidden file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-faint focus-visible:border-ring focus-visible:shadow-focus disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 autofill:[-webkit-text-fill-color:var(--foreground)] autofill:caret-foreground autofill:shadow-[inset_0_0_0_1000px_var(--ryadom-paper)] autofill:transition-[background-color] autofill:duration-[9999s] aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/25",
        className
      )}
      {...props}
    />
  )
}

export { Input }
