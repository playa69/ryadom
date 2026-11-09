import { useId } from 'react'
import { NativeCheckbox } from '@ryadom/ui/components/native-checkbox'
import { cn } from '@ryadom/ui/lib/utils'
import { ExternalLink } from './parts'

interface DocumentLinks {
  termsUrl: string
  consentUrl: string
  className?: string
}

export function ConsentNotice({ termsUrl, consentUrl, className }: DocumentLinks) {
  return (
    <p
      className={cn('text-[0.8125rem] leading-normal text-faint text-balance', className)}
      data-testid="consent-notice"
    >
      «Рядом»&nbsp;— ИИ для самоподдержки, а не психотерапия и не медицинская помощь.{' '}
      <ExternalLink href={termsUrl}>Условия использования</ExternalLink> и{' '}
      <ExternalLink href={consentUrl}>согласие на обработку данных</ExternalLink>.
    </p>
  )
}

interface ConsentCheckboxProps extends DocumentLinks {
  checked: boolean
  onCheckedChange(checked: boolean): void
}

export function ConsentCheckbox({
  checked,
  onCheckedChange,
  termsUrl,
  consentUrl,
  className,
}: ConsentCheckboxProps) {
  const id = useId()
  const labelId = `${id}-label`

  return (
    <div className={cn('flex items-start gap-2.5 text-left', className)} data-testid="data-consent">
      <NativeCheckbox
        id={id}
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
        aria-labelledby={labelId}
        required
        data-testid="data-consent-toggle"
        className="mt-0.5 rounded-[6px]"
      />
      <p id={labelId} className="text-sm leading-normal text-dim text-balance">
        Мне есть 18 лет, я принимаю <ExternalLink href={termsUrl}>условия использования</ExternalLink> и даю{' '}
        <ExternalLink href={consentUrl}>согласие на обработку персональных данных</ExternalLink>, включая
        голос и текст разговоров.
      </p>
    </div>
  )
}
