import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, asc, count, desc, eq, ilike, or, type SQL } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { SearchUsersQuery } from './search-users.query'
import type { SearchUsersQueryResult } from './search-users.types'
import { toUserDTO } from '../../shared/user.dto'

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => '\\' + char)
}

/** Admin search by email, name or id, with status filters. */
@requestHandler(SearchUsersQuery)
export class SearchUsersQueryHandler implements RequestHandler<SearchUsersQuery, SearchUsersQueryResult> {
  async handle(query: SearchUsersQuery): Promise<SearchUsersQueryResult> {
    const conditions: SQL[] = []
    const term = query.search.trim()
    if (term) {
      const pattern = '%' + escapeLike(term) + '%'
      const byTerm = [ilike(users.email, pattern), ilike(users.name, pattern)]
      if (isUuid(term)) byTerm.push(eq(users.id, term))
      conditions.push(or(...byTerm) as SQL)
    }
    if (query.filterActive !== undefined) conditions.push(eq(users.isActive, query.filterActive))
    if (query.filterEmailConfirmed !== undefined) {
      conditions.push(eq(users.isEmailConfirmed, query.filterEmailConfirmed))
    }
    if (query.filterDeleted !== undefined) conditions.push(eq(users.isDeleted, query.filterDeleted))
    const where = conditions.length > 0 ? and(...conditions) : undefined
    const column = query.sortBy === 'email' ? users.email : query.sortBy === 'name' ? users.name : users.createdAt
    const order = query.sortOrder === 'asc' ? asc(column) : desc(column)

    const db = getDb()
    const [rows, totals] = await Promise.all([
      db
        .select()
        .from(users)
        .where(where)
        .orderBy(order, asc(users.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ value: count() }).from(users).where(where),
    ])
    return { success: true, users: rows.map(toUserDTO), total: totals[0]?.value ?? 0 }
  }
}
