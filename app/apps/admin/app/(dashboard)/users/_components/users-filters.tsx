'use client'

import { Loader2, Search, X } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useEffectEvent, useRef, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { UsersQuery } from '../shared'

const SEARCH_DEBOUNCE_MS = 300
// Radix Select cannot hold an empty value, so "no filter" is a word here and nothing in the URL.
const ANY = 'any'

type Option = readonly [value: string, label: string]

const ACTIVE_OPTIONS: Option[] = [
  [ANY, 'Любой'],
  ['yes', 'Активен'],
  ['no', 'Заблокирован'],
]
const CONFIRMED_OPTIONS: Option[] = [
  [ANY, 'Любая'],
  ['yes', 'Подтверждена'],
  ['no', 'Не подтверждена'],
]
const DELETED_OPTIONS: Option[] = [
  [ANY, 'Показывать'],
  ['no', 'Скрыть'],
  ['yes', 'Только удалённые'],
]
const SORT_OPTIONS: Option[] = [
  ['createdAt', 'По дате'],
  ['email', 'По почте'],
  ['name', 'По имени'],
]

function triValue(value: boolean | undefined): string {
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return ANY
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: Option[]
  onChange: (value: string) => void
}) {
  return (
    <div>
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-9 bg-white">
          {/* Untouched filters show just their name, which keeps the idle row short. */}
          <SelectValue>
            {value === ANY ? (
              <>
                <span className="text-gray-600">{label}</span>
                <span className="sr-only">: {options.find(([optionValue]) => optionValue === ANY)?.[1]}</span>
              </>
            ) : (
              <>
                <span className="text-gray-600">{label}:</span> {options.find(([optionValue]) => optionValue === value)?.[1]}
              </>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>
              {optionLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * One filter row that applies as you go. Everything lands in the same query string the server
 * page already reads, so a page of results is still a link and server-side paging keeps working.
 */
export default function UsersFilters({ query }: { query: UsersQuery }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const [search, setSearch] = useState(query.search)
  // What the URL last got from this input; tells our own navigation apart from back/forward.
  const sentSearch = useRef(query.search)

  // searchParams is only the committed URL: a change made while a navigation is in flight would
  // start from stale params and drop the earlier one. So every change builds on this ref instead.
  const urlString = searchParams.toString()
  const intended = useRef(new URLSearchParams(urlString))
  useEffect(() => {
    // The URL moved without us (sidebar link, back/forward, a pager link): follow it once idle.
    if (!pending) intended.current = new URLSearchParams(urlString)
  }, [urlString, pending])

  function apply(changes: Record<string, string | null>) {
    const params = new URLSearchParams(intended.current)
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    // A new set of conditions starts from the first page.
    params.delete('page')
    intended.current = params
    const qs = params.toString()
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
  }
  function submitSearch(value: string) {
    sentSearch.current = value
    apply({ q: value })
  }
  // The debounce timer must see the latest closure, not the one from the render that armed it.
  const applySearch = useEffectEvent(submitSearch)

  // The URL changed without this input (the sidebar link back to /users, back/forward): follow it.
  // Not while our own navigation is in flight, or a late answer would overwrite what is being typed.
  useEffect(() => {
    if (!pending && query.search !== sentSearch.current) {
      sentSearch.current = query.search
      setSearch(query.search)
    }
  }, [query.search, pending])

  useEffect(() => {
    const next = search.trim()
    if (next === sentSearch.current) return
    const timer = setTimeout(() => applySearch(next), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  const hasFilters =
    search !== '' ||
    query.filterActive !== undefined ||
    query.filterEmailConfirmed !== undefined ||
    query.filterDeleted !== undefined ||
    query.sortBy !== 'createdAt'

  return (
    <form
      role="search"
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        // Enter should not wait for the debounce.
        event.preventDefault()
        submitSearch(search.trim())
      }}
    >
      <div className="relative min-w-40 max-w-md flex-1 basis-56">
        <Label htmlFor="q" className="sr-only">
          Почта, имя или id
        </Label>
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gray-500"
          aria-hidden="true"
        />
        <Input
          id="q"
          name="q"
          type="search"
          autoComplete="off"
          maxLength={120}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Почта, имя или id"
          className="bg-white pl-9 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {pending && (
          <Loader2
            className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-gray-500"
            aria-hidden="true"
          />
        )}
      </div>

      <FilterSelect
        id="active"
        label="Доступ"
        value={triValue(query.filterActive)}
        options={ACTIVE_OPTIONS}
        onChange={(value) => apply({ active: value === ANY ? null : value })}
      />
      <FilterSelect
        id="confirmed"
        label="Почта"
        value={triValue(query.filterEmailConfirmed)}
        options={CONFIRMED_OPTIONS}
        onChange={(value) => apply({ confirmed: value === ANY ? null : value })}
      />
      <FilterSelect
        id="deleted"
        label="Удалённые"
        value={triValue(query.filterDeleted)}
        options={DELETED_OPTIONS}
        onChange={(value) => apply({ deleted: value === ANY ? null : value })}
      />
      <FilterSelect
        id="sort"
        label="Сортировка"
        value={query.sortBy}
        options={SORT_OPTIONS}
        // The newest-first default needs no parameters; text columns read A to Z.
        onChange={(value) =>
          apply(value === 'createdAt' ? { sort: null, order: null } : { sort: value, order: 'asc' })
        }
      />

      {hasFilters && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Сбросить"
          title="Сбросить"
          // Icon only below 2xl: a text button would wrap the row at 1280 the moment a filter is set.
          className="text-gray-600 2xl:w-auto 2xl:px-3"
          onClick={() => {
            sentSearch.current = ''
            intended.current = new URLSearchParams()
            setSearch('')
            startTransition(() => router.replace(pathname, { scroll: false }))
          }}
        >
          <X />
          <span className="hidden 2xl:inline">Сбросить</span>
        </Button>
      )}
    </form>
  )
}
