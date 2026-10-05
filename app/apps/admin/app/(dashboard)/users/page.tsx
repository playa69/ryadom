import { SearchUsersQuery, usersManager } from '@ryadom/core/managers/users-manager'
import { UserX } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { ListFooter } from '@/components/list-footer'
import { PageHeader } from '@/components/page-header'
import { StatusBadge } from '@/components/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { requireAdmin } from '@/lib/session'
import { formatMoscow, userStatus } from '../_lib/labels'
import UsersFilters from './_components/users-filters'
import { PAGE_SIZE, parseUsersQuery } from './shared'

export const metadata: Metadata = { title: 'Пользователи — админка «Рядом»' }
export const dynamic = 'force-dynamic'

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const query = parseUsersQuery(await searchParams)

  const result = await usersManager.execute(
    new SearchUsersQuery({
      search: query.search,
      page: query.page,
      pageSize: PAGE_SIZE,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      filterActive: query.filterActive,
      filterEmailConfirmed: query.filterEmailConfirmed,
      filterDeleted: query.filterDeleted,
    }),
  )

  const lastPage = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
  const pageHref = (page: number) => {
    const params = new URLSearchParams()
    if (query.search) params.set('q', query.search)
    if (query.sortBy !== 'createdAt') params.set('sort', query.sortBy)
    if (query.sortOrder !== 'desc') params.set('order', query.sortOrder)
    if (query.filterActive !== undefined) params.set('active', query.filterActive ? 'yes' : 'no')
    if (query.filterEmailConfirmed !== undefined) params.set('confirmed', query.filterEmailConfirmed ? 'yes' : 'no')
    if (query.filterDeleted !== undefined) params.set('deleted', query.filterDeleted ? 'yes' : 'no')
    if (page > 1) params.set('page', String(page))
    const qs = params.toString()
    return qs ? `/users?${qs}` : '/users'
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Пользователи">Поиск по почте, имени и идентификатору.</PageHeader>

      <div className="space-y-4">
        <UsersFilters query={query} />

        <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
          {result.users.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
              <UserX className="size-8 text-gray-400" aria-hidden="true" />
              <p className="text-sm text-gray-600">Никого не нашлось. Попробуйте изменить условия поиска.</p>
            </div>
          ) : (
            <Table>
              <TableHeader className="bg-gray-50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs text-gray-600">Почта</TableHead>
                  <TableHead className="text-xs text-gray-600">Имя</TableHead>
                  <TableHead className="text-xs text-gray-600">Статус</TableHead>
                  <TableHead className="text-xs whitespace-normal text-gray-600">Почта подтверждена</TableHead>
                  <TableHead className="text-xs text-gray-600">Регистрация</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.users.map((user) => {
                  const status = userStatus(user)
                  return (
                    <TableRow key={user.id}>
                      <TableCell>
                        {/* One line with an ellipsis: an address cut in the middle of a word reads as a bug. */}
                        <span className="block max-w-80 truncate" title={user.email ?? user.id}>
                          <Link
                            href={`/users/${user.id}`}
                            className="font-medium text-blue-600 hover:underline"
                          >
                            {user.email ?? `Без почты · ${user.id.slice(0, 8)}`}
                          </Link>
                        </span>
                      </TableCell>
                      <TableCell className="max-w-56 min-w-28 break-words whitespace-normal text-gray-700">
                        {user.name ?? <span className="text-gray-500">—</span>}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                      </TableCell>
                      <TableCell>
                        {user.email === null ? (
                          <span className="text-gray-500">—</span>
                        ) : user.isEmailConfirmed ? (
                          <StatusBadge tone="success">да</StatusBadge>
                        ) : (
                          <StatusBadge tone="warning">нет</StatusBadge>
                        )}
                      </TableCell>
                      <TableCell className="min-w-28 whitespace-normal text-gray-600 tabular-nums">{formatMoscow(user.createdAt)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
          <ListFooter total={result.total} page={query.page} lastPage={lastPage} hrefFor={pageHref} />
        </div>
      </div>
    </div>
  )
}
