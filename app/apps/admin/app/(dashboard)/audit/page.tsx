import { auditLogManager, GetAuditLogQuery } from '@ryadom/core/managers/audit-log-manager'
import { ScrollText } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ListFooter } from '@/components/list-footer'
import { PageHeader } from '@/components/page-header'
import { StatusBadge } from '@/components/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { requireAdmin } from '@/lib/session'
import { AUDIT_ACTION_LABELS, AUDIT_ACTION_TONES, describePayload, formatMoscow } from '../_lib/labels'

export const metadata: Metadata = { title: 'Журнал действий — админка «Рядом»' }
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

/**
 * Every admin action against a user account is recorded. The log is append-only and has no
 * interface for editing: that is the whole point of having it.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const params = await searchParams
  const rawPage = Array.isArray(params.page) ? params.page[0] : params.page
  const parsed = Number.parseInt(rawPage ?? '1', 10)
  const page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1
  const rawUser = Array.isArray(params.user) ? params.user[0] : params.user

  const result = await auditLogManager.execute(
    new GetAuditLogQuery({ page, pageSize: PAGE_SIZE, targetUserId: rawUser || undefined }),
  )

  const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
  const pageHref = (next: number) => {
    const qs = new URLSearchParams()
    if (rawUser) qs.set('user', rawUser)
    if (next > 1) qs.set('page', String(next))
    const value = qs.toString()
    return value ? `/audit?${value}` : '/audit'
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Журнал действий">
        {rawUser ? (
          <>
            Действия над одним пользователем.{' '}
            <Link href="/audit" className="rounded-sm text-blue-600 hover:underline">
              Показать все
            </Link>
          </>
        ) : (
          'Что администраторы делали с аккаунтами. Записи не редактируются и не удаляются.'
        )}
      </PageHeader>

      <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
        {result.entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
            <ScrollText className="size-8 text-gray-400" aria-hidden="true" />
            <p className="text-sm text-gray-600">Пока ничего не происходило.</p>
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-gray-50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs text-gray-600">Когда и кто</TableHead>
                <TableHead className="text-xs text-gray-600">Что сделал</TableHead>
                <TableHead className="text-xs text-gray-600">С кем</TableHead>
                <TableHead className="text-xs text-gray-600">Подробности</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <div className="text-gray-900 tabular-nums">{formatMoscow(entry.createdAt)}</div>
                    <div className="text-xs text-gray-500">{entry.adminEmail}</div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={AUDIT_ACTION_TONES[entry.action]}>{AUDIT_ACTION_LABELS[entry.action]}</StatusBadge>
                  </TableCell>
                  <TableCell>
                    {/* One line with an ellipsis: an address cut in the middle of a word reads as a bug. */}
                    <span className="block max-w-72 truncate" title={entry.targetEmail ?? undefined}>
                      {entry.targetUserId ? (
                        <Link
                          href={`/users/${entry.targetUserId}`}
                          className="font-medium text-blue-600 hover:underline"
                        >
                          {entry.targetEmail ?? entry.targetUserId}
                        </Link>
                      ) : (
                        <span className="text-gray-600">{entry.targetEmail ?? '—'}</span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="min-w-40 whitespace-normal text-gray-600">{describePayload(entry.payload)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <ListFooter total={result.total} page={page} lastPage={lastPage} hrefFor={pageHref} />
      </div>
    </div>
  )
}
