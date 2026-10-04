import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-24 w-full rounded-lg border border-input bg-glass px-4 py-3 text-base shadow-card transition-colors outline-hidden placeholder:text-faint focus-visible:border-ring focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 autofill:text-fill-foreground autofill:shadow-[inset_0_0_0_1000px_var(--ryadom-paper)] autofill:transition-[background-color] autofill:duration-[9999s] aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/25",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
