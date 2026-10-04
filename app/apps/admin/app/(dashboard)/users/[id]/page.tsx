import { GetUserByIdQuery, usersManager } from '@ryadom/core/managers/users-manager'
import { isUuid } from '@ryadom/core/shared'
import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { StatusBadge } from '@/components/status-badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireAdmin } from '@/lib/session'
import { formatMoscow, userStatus } from '../../_lib/labels'
import DeleteAccount from './_components/delete-account'
import UserActions from './_components/user-actions'

export const metadata: Metadata = { title: 'Пользователь — админка «Рядом»' }
export const dynamic = 'force-dynamic'

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-gray-600">{label}</dt>
      <dd className="mt-1 text-sm break-words text-gray-900">{children}</dd>
    </div>
  )
}

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin()
  const { id } = await params
  // A non-uuid would reach the database as a broken query; treat it as "no such page".
  if (!isUuid(id)) notFound()

  const result = await usersManager.execute(new GetUserByIdQuery({ userId: id }))
  // The only failure this query has is "no such user", and for a page that is a 404.
  if (!result.success) notFound()

  const user = result.user
  const status = userStatus(user)

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <Link
          href="/users"
          className="inline-flex items-center gap-1 rounded-sm text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Пользователи
        </Link>
        <h1 className="text-2xl font-bold break-all text-gray-900">{user.email}</h1>
        <div className="flex flex-wrap gap-2">
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          {user.isEmailConfirmed ? (
            <StatusBadge tone="success">Почта подтверждена</StatusBadge>
          ) : (
            <StatusBadge tone="warning">Почта не подтверждена</StatusBadge>
          )}
        </div>
      </div>

      {/* Below xl the wrappers dissolve and `order` puts the actions right after the profile. */}
      <div className="flex flex-col gap-6 xl:grid xl:grid-cols-3 xl:items-start">
        <div className="contents xl:col-span-2 xl:block xl:space-y-6">
          <Card size="sm" className="order-1">
            <CardHeader>
              <CardTitle className="font-semibold text-gray-900">Профиль</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
                <Fact label="Идентификатор">
                  <span className="font-mono text-xs break-all">{user.id}</span>
                </Fact>
                <Fact label="Имя">{user.name ?? <span className="text-gray-600">не указано</span>}</Fact>
                <Fact label="Почта подтверждена">{user.isEmailConfirmed ? 'да' : 'нет'}</Fact>
                <Fact label="Регистрация">{formatMoscow(user.createdAt)}</Fact>
                <Fact label="Последнее изменение">{formatMoscow(user.updatedAt)}</Fact>
                {user.deletedAt && <Fact label="Удалён">{formatMoscow(user.deletedAt)}</Fact>}
              </dl>
            </CardContent>
          </Card>

          <Card size="sm" className="order-4">
            <CardHeader>
              <CardTitle className="font-semibold text-gray-900">История</CardTitle>
            </CardHeader>
            <CardContent>
              <Link
                href={`/audit?user=${user.id}`}
                className="w-fit rounded-sm text-blue-600 hover:underline"
              >
                Что администраторы делали с этим аккаунтом
              </Link>
            </CardContent>
          </Card>

          <Card size="sm" className="order-5">
            <CardHeader>
              <CardTitle className="font-semibold text-gray-900">Разговоры</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600">
                Содержание разговоров в админке не показывается: доступ к ним есть только у самого
                человека. Здесь видно только сам факт существования аккаунта.
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="contents xl:block xl:space-y-6">
          <Card size="sm" className="order-2">
            <CardHeader>
              <CardTitle className="font-semibold text-gray-900">Действия</CardTitle>
            </CardHeader>
            <CardContent>
              <UserActions
                userId={user.id}
                isActive={user.isActive}
                isDeleted={user.isDeleted}
                isEmailConfirmed={user.isEmailConfirmed}
              />
            </CardContent>
          </Card>

          {!user.isDeleted && (
            <Card size="sm" className="order-3 border-red-200">
              <CardHeader>
                <CardTitle className="font-semibold text-red-700">Опасная зона</CardTitle>
                <CardDescription className="text-gray-600">
                  Аккаунт и все разговоры стираются без возможности восстановления.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DeleteAccount userId={user.id} email={user.email} />
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
