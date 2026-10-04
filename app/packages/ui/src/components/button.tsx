import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-base font-semibold whitespace-nowrap transition-[filter,scale,background-color,border-color,box-shadow] outline-hidden select-none focus-visible:shadow-focus active:not-aria-[haspopup]:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "cta hover:brightness-[1.12] focus-visible:shadow-[var(--ryadom-focus),var(--ryadom-cta-glow)]",
        outline:
          "glass border-input text-foreground hover:border-muted-foreground hover:bg-white/5 aria-expanded:bg-white/5",
        secondary:
          "border-border bg-secondary text-secondary-foreground hover:bg-white/10 aria-expanded:bg-secondary",
        ghost:
          "text-muted-foreground hover:bg-white/8 hover:text-foreground aria-expanded:bg-white/8 aria-expanded:text-foreground",
        destructive:
          "border-danger-line bg-danger-soft text-destructive hover:bg-destructive/20 ",
        danger:
          "bg-danger-strong text-white hover:brightness-110",
        link: "h-auto rounded-sm px-0 text-brand-400 underline underline-offset-4 hover:brightness-110",
      },
      size: {
        default:
          "h-13 gap-2 px-7",
        xs: "h-9 gap-1.5 px-3 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-11 gap-2 px-5 text-[0.9375rem]",
        lg: "h-14 gap-2.5 px-8",
        icon: "size-11",
        "icon-xs": "size-8",
        "icon-sm": "size-9",
        "icon-lg": "size-13",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
