import type { SortOrder, UserSearchSortBy } from '@ryadom/core/managers/users-manager'

export const PAGE_SIZE = 25

export interface UsersQuery {
  search: string
  page: number
  sortBy: UserSearchSortBy
  sortOrder: SortOrder
  filterActive?: boolean
  filterEmailConfirmed?: boolean
  filterDeleted?: boolean
}

function triState(value: string | undefined): boolean | undefined {
  if (value === 'yes') return true
  if (value === 'no') return false
  return undefined
}

/** Anything unexpected in the query string falls back to the default rather than erroring. */
export function parseUsersQuery(params: Record<string, string | string[] | undefined>): UsersQuery {
  const one = (key: string): string | undefined => {
    const value = params[key]
    return Array.isArray(value) ? value[0] : value
  }
  const page = Number.parseInt(one('page') ?? '1', 10)
  const sortBy = one('sort')
  const order = one('order')
  return {
    search: (one('q') ?? '').trim().slice(0, 120),
    page: Number.isFinite(page) && page > 0 ? page : 1,
    sortBy: sortBy === 'email' || sortBy === 'name' ? sortBy : 'createdAt',
    sortOrder: order === 'asc' ? 'asc' : 'desc',
    filterActive: triState(one('active')),
    filterEmailConfirmed: triState(one('confirmed')),
    filterDeleted: triState(one('deleted')),
  }
}
