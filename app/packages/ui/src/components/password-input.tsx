"use client"

import * as React from "react"
import { cn } from "cn"
import { EyeIcon, EyeOffIcon } from "lucide-react"

import { Button } from "@ryadom/ui/components/button"
import { Input } from "@ryadom/ui/components/input"

/**
 * A password field with a reveal button: a typo in a masked password is invisible to the person.
 * It is only the input; wrap it in a Field with a Label and a hint like any other control.
 */
function PasswordInput({
  className,
  id,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "type">) {
  const [visible, setVisible] = React.useState(false)
  const generatedId = React.useId()
  const inputId = id ?? generatedId

  return (
    <div className="relative">
      <Input
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        {...props}
        id={inputId}
        type={visible ? "text" : "password"}
        className={cn("pr-13", className)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        // Centered with auto margins, not a translate: Button's :active press is a translate-y, which would
        // replace the centering, move the button off the pointer mid-press and cancel the click.
        className="absolute inset-y-0 right-1 my-auto cursor-pointer border-0 text-faint hover:bg-transparent hover:text-faint hover:brightness-[1.12] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        aria-label={visible ? "Скрыть пароль" : "Показать пароль"}
        aria-controls={inputId}
        onClick={() => setVisible((previous) => !previous)}
      >
        {/* size-* on the icon itself: the button's own svg rule only yields to a size class there. */}
        {visible ? (
          <EyeOffIcon className="size-5" strokeWidth={1.8} />
        ) : (
          <EyeIcon className="size-5" strokeWidth={1.8} />
        )}
      </Button>
    </div>
  )
}

export { PasswordInput }
