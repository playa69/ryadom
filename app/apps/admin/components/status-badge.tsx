import type * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type Tone = 'success' | 'danger' | 'warning' | 'info' | 'neutral' | 'dark'

// Tinted pairs; the -700/-800 text keeps at least 4.5:1 on its -100 background.
const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-emerald-100 text-emerald-700',
  danger: 'bg-red-100 text-red-700',
  warning: 'bg-amber-100 text-amber-800',
  info: 'bg-blue-100 text-blue-700',
  neutral: 'bg-gray-100 text-gray-700',
  dark: 'bg-gray-800 text-white',
}

export function StatusBadge({
  tone,
  className,
  ...props
}: { tone: Tone } & Omit<React.ComponentProps<typeof Badge>, 'variant'>) {
  return <Badge variant="secondary" className={cn(TONE_CLASSES[tone], className)} {...props} />
}
