import { CircleAlert, CircleCheck } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { cn } from '@/lib/utils'

/** An inline result message: a red box for a failure, a green one for success. */
export function Notice({
  tone,
  className,
  children,
}: {
  tone: 'error' | 'success'
  className?: string
  children: React.ReactNode
}) {
  const error = tone === 'error'
  return (
    <Alert
      className={cn(
        error ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-800',
        className,
      )}
    >
      {error ? <CircleAlert /> : <CircleCheck />}
      <AlertDescription className="text-inherit">{children}</AlertDescription>
    </Alert>
  )
}
