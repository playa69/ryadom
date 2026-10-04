'use client'

import { ChevronsUpDown, LogOut, SquarePen, UserRound, Users } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo } from 'react'
import type { DialogListItemApiResponse } from '@ryadom/contracts/api/dialogs'
import { ANONYMOUS_RETENTION_DAYS } from '@ryadom/contracts/api/policy'
import { Avatar, AvatarFallback } from '@ryadom/ui/components/avatar'
import { Button } from '@ryadom/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ryadom/ui/components/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from '@ryadom/ui/components/sidebar'
import { useAuth } from '@/lib/auth'
import { useJournal } from '@/lib/journal'
import { groupJournal } from '@/lib/journal-groups'
import { BrandMark } from './Brand'

/** An open conversation is resumed in the dialog screen; a finished one opens read-only in the journal. */
function itemHref(item: DialogListItemApiResponse): string {
  const id = encodeURIComponent(item.dialogId)
  return item.endedAt ? `/journal/${id}` : `/dialog/${id}`
}

function itemTitle(item: DialogListItemApiResponse): string {
  return item.summary?.title || 'Разговор'
}

/**
 * The left column of the signed-in app: the brand, "new conversation", the people-nearby page, the
 * history of conversations grouped by day, and the account menu at the bottom. On a phone the same
 * content opens as a drawer from the menu button in the page header; on a desktop it collapses to an
 * icon rail.
 */
export default function AppSidebar() {
  const pathname = usePathname()
  const { user, logout } = useAuth()
  const { items, error, refresh } = useJournal()
  const { isMobile, setOpenMobile } = useSidebar()

  // The history is cheap to re-read (parallel calls share one request) and a conversation that just
  // ended or started must show up as soon as the person navigates.
  useEffect(() => {
    void refresh()
  }, [pathname, refresh])

  // The drawer on a phone closes itself when the person picks something.
  useEffect(() => {
    setOpenMobile(false)
  }, [pathname, setOpenMobile])

  const groups = useMemo(() => groupJournal(items ?? []), [items])
  // An account opened by this device alone has no way back in other than it: that is shown as what it
  // is (a guest, with an offer to keep the conversations), not as an account with empty fields.
  const anonymous = user?.email === null || user?.isEmailConfirmed === false
  const awaitsCode = user?.email != null && user.isEmailConfirmed === false
  const named = user?.name?.trim() || null
  const name = named || user?.email || (anonymous ? 'Гость' : '')
  const initial = name.charAt(0).toUpperCase() || '·'

  return (
    <Sidebar collapsible="icon" className="border-line **:data-[sidebar=sidebar]:backdrop-blur-2xl">
      {/* The landmark for the sidebar's links (brand, new conversation, history); the account menu below is not navigation. */}
      <nav
        aria-label="Основное"
        className="flex min-h-0 flex-1 flex-col"
        // A link to the page already open does not change the path, so the effect above would leave the drawer up.
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('a')) setOpenMobile(false)
        }}
      >
        <SidebarHeader className="gap-3 p-3 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0">
          <Link
            href="/home"
            aria-label="Рядом — на главную"
            className="flex min-h-11 items-center gap-2.5 rounded-lg px-1 outline-hidden group-data-[collapsible=icon]:px-0 focus-visible:shadow-focus"
          >
            <BrandMark size={32} className="shrink-0" />
            <span className="text-xl font-bold tracking-display text-foreground group-data-[collapsible=icon]:hidden">
              Рядом<span className="text-brand-400">.</span>
            </span>
          </Link>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="w-full justify-start px-4 group-data-[collapsible=icon]:size-9 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
          >
            <Link href="/home" aria-label="Новый разговор">
              <SquarePen className="text-brand-400" />
              <span className="group-data-[collapsible=icon]:hidden">Новый разговор</span>
            </Link>
          </Button>
        </SidebarHeader>

        <SidebarContent className="px-1">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip={isMobile ? undefined : 'Люди рядом'}
                    isActive={pathname === '/people'}
                    className="h-10 text-[0.9375rem]"
                  >
                    <Link href="/people" aria-current={pathname === '/people' ? 'page' : undefined}>
                      <Users />
                      <span>Люди рядом</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* The history has no icon-rail form: a column of identical glyphs says nothing. */}
          <div className="min-h-0 flex-1 overflow-y-auto group-data-[collapsible=icon]:hidden">
            {items === null && !error && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu aria-busy="true">
                    {[0, 1, 2, 3].map((n) => (
                      <SidebarMenuItem key={n}>
                        <SidebarMenuSkeleton />
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            {items !== null && items.length === 0 && (
              <p className="px-4 py-3 text-sm leading-snug text-faint">
                Здесь появятся твои разговоры. Аудио не сохраняется — только текст.
              </p>
            )}

            {groups.map((group) => (
              <SidebarGroup key={group.key}>
                <SidebarGroupLabel className="text-[0.8125rem] font-semibold text-faint">
                  {group.label}
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => {
                      const href = itemHref(item)
                      return (
                        <SidebarMenuItem key={item.dialogId}>
                          <SidebarMenuButton
                            asChild
                            isActive={pathname === href}
                            className="h-10 text-[0.9375rem]"
                          >
                            <Link
                              href={href}
                              data-testid="history-item"
                              aria-current={pathname === href ? 'page' : undefined}
                            >
                              <span className="truncate">{itemTitle(item)}</span>
                              {!item.endedAt && (
                                <span
                                  role="img"
                                  aria-label="Разговор не завершён"
                                  className="ml-auto size-2 shrink-0 rounded-full bg-brand"
                                />
                              )}
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}

            {error && items !== null && (
              <p className="px-4 py-2 text-sm text-danger" role="status">
                {error}
              </p>
            )}
          </div>

          {/* Outside the scrolling list: with forty conversations the way to the full list must not be at the bottom of them. */}
          {items !== null && items.length > 0 && (
            <div className="shrink-0 px-1 pt-1 pb-2 group-data-[collapsible=icon]:hidden">
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="h-10 w-full justify-start px-3 text-[0.9375rem] font-medium text-dim hover:text-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-foreground"
              >
                <Link href="/journal" aria-current={pathname === '/journal' ? 'page' : undefined}>
                  Все разговоры
                </Link>
              </Button>
            </div>
          )}
        </SidebarContent>
      </nav>

      <SidebarFooter className="border-t border-line p-2 group-data-[collapsible=icon]:px-3">
        {anonymous && (
          <div
            data-testid="guest-card"
            className="mb-1 flex flex-col gap-2 rounded-lg border border-brand-line bg-brand-soft p-3 group-data-[collapsible=icon]:hidden"
          >
            <p className="text-sm font-semibold text-foreground">Сохрани разговоры</p>
            <p className="text-xs leading-snug text-dim">
              Без почты они хранятся {ANONYMOUS_RETENTION_DAYS} дней. С почтой не потеряются и откроются на
              другом устройстве.
            </p>
            <Button asChild size="sm" className="h-10 w-full bg-clip-border text-[0.9375rem]">
              <Link href="/profile?linkEmail=1" data-testid="guest-card-link">
                {awaitsCode ? 'Подтвердить почту' : 'Привязать почту'}
              </Link>
            </Button>
          </div>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              // The drawer has no icon rail to label, and a hidden tooltip that opens on focus would take the first Esc meant for the drawer.
              tooltip={isMobile ? undefined : name}
              className="h-14 data-[state=open]:bg-sidebar-accent"
              data-testid="account-menu"
            >
              <Avatar className="size-9 rounded-full group-data-[collapsible=icon]:size-8">
                <AvatarFallback className="rounded-full bg-brand-soft font-semibold text-brand-400">
                  {anonymous && !named && !user?.email ? (
                    <UserRound className="size-5" strokeWidth={1.8} aria-hidden="true" />
                  ) : (
                    initial
                  )}
                </AvatarFallback>
              </Avatar>
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate text-[0.9375rem] font-semibold">
                  {named || (anonymous ? 'Гость' : 'Аккаунт')}
                </span>
                <span className="truncate text-xs text-faint">{user?.email ?? 'Без регистрации'}</span>
              </span>
              <ChevronsUpDown className="ml-auto size-4 shrink-0 text-faint" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
          >
            <DropdownMenuItem asChild className="h-11">
              <Link href="/profile">
                <UserRound />
                Профиль
              </Link>
            </DropdownMenuItem>
            {/* An account opened by this device alone has nothing to sign out of: the profile says how to leave it. */}
            {!anonymous && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="h-11" onSelect={() => void logout()}>
                  <LogOut />
                  Выйти
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
