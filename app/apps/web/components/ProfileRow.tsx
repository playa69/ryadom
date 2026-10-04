import Link from 'next/link'
import {
  ChevronRight,
  ExternalLink,
  FileText,
  Info,
  Lock,
  Mail,
  Trash2,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { Item, ItemContent, ItemTitle } from '@ryadom/ui/components/item'
import { cn } from '@ryadom/ui/lib/utils'
import { ROW, RowIcon } from './ProfileParts'

const ICONS = {
  lock: Lock,
  mail: Mail,
  users: Users,
  info: Info,
  doc: FileText,
  trash: Trash2,
} satisfies Record<string, LucideIcon>

type ProfileRowIcon = keyof typeof ICONS

interface BaseProps {
  icon: ProfileRowIcon
  label: string
  /** Quiet text before the chevron, e.g. the current version. */
  value?: string
  danger?: boolean
  testId?: string
}

type Props = BaseProps &
  (
    | { href: string; external?: boolean; onClick?: undefined }
    | { onClick(): void; href?: undefined; external?: undefined }
  )

/**
 * One row of a settings list. It is a real link for navigation, a link that opens a new tab for
 * documents, and a button for actions that stay on the page, so the keyboard and the screen reader
 * get the right element each time.
 */
export default function ProfileRow({
  icon,
  label,
  value,
  danger = false,
  testId,
  href,
  external,
  onClick,
}: Props) {
  const className = cn(
    ROW,
    danger ? 'text-danger hover:bg-danger-soft [a]:hover:bg-danger-soft' : 'hover:bg-white/5 [a]:hover:bg-white/5',
  )
  const content = (
    <>
      <RowIcon icon={ICONS[icon]} danger={danger} />
      {/* Words are never cut in the middle unless one cannot fit at all; on a very narrow screen
          (320px) the quiet value gives way first. */}
      <ItemContent>
        <ItemTitle className="line-clamp-none text-base leading-[1.35] wrap-break-word">{label}</ItemTitle>
      </ItemContent>
      {external && <span className="sr-only">(откроется в новой вкладке)</span>}
      {value && <span className="text-sm font-normal whitespace-nowrap text-faint max-[22.5rem]:hidden">{value}</span>}
      {external ? (
        <ExternalLink className="size-4 shrink-0 text-faint" strokeWidth={1.8} aria-hidden="true" />
      ) : (
        <ChevronRight
          className={cn('size-[18px] shrink-0 text-faint', danger && 'text-danger')}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      )}
    </>
  )

  if (href === undefined) {
    return (
      <Item asChild className={cn(className, 'cursor-pointer')}>
        <button type="button" data-testid={testId} onClick={onClick}>
          {content}
        </button>
      </Item>
    )
  }
  if (external) {
    // noopener: the landing is a different origin and must not get a handle on the signed-in window.
    return (
      <Item asChild className={className}>
        <a data-testid={testId} href={href} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      </Item>
    )
  }
  return (
    <Item asChild className={className}>
      <Link data-testid={testId} href={href}>
        {content}
      </Link>
    </Item>
  )
}
