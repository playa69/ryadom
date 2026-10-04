import { RequestData } from 'mediatr-ts'
import type { SortOrder, UserSearchSortBy } from '../../shared/user.dto'
import type { SearchUsersQueryResult } from './search-users.types'

export interface SearchUsersQueryData {
  search: string
  page: number
  pageSize: number
  sortBy: UserSearchSortBy
  sortOrder: SortOrder
  filterActive?: boolean
  filterEmailConfirmed?: boolean
  filterDeleted?: boolean
}

export class SearchUsersQuery extends RequestData<SearchUsersQueryResult> {
  /** Survives minification: SearchUsersQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'SearchUsersQuery'

  public readonly search: string
  public readonly page: number
  public readonly pageSize: number
  public readonly sortBy: UserSearchSortBy
  public readonly sortOrder: SortOrder
  public readonly filterActive?: boolean
  public readonly filterEmailConfirmed?: boolean
  public readonly filterDeleted?: boolean

  constructor(data: SearchUsersQueryData) {
    super()
    this.search = data.search
    this.page = data.page
    this.pageSize = data.pageSize
    this.sortBy = data.sortBy
    this.sortOrder = data.sortOrder
    this.filterActive = data.filterActive
    this.filterEmailConfirmed = data.filterEmailConfirmed
    this.filterDeleted = data.filterDeleted
  }
}
