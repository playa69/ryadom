import { ChevronLeft, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination'

interface Props {
  total: number
  page: number
  lastPage: number
  hrefFor: (page: number) => string
}

/** The bottom edge of a list card: how many rows matched and the way to the neighbouring pages. */
export function ListFooter({ total, page, lastPage, hrefFor }: Props) {
  const hasPrev = page > 1
  const hasNext = page < lastPage
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 px-4 py-3 text-sm text-gray-600">
      <span>
        Найдено: <span className="font-medium text-gray-900 tabular-nums">{total}</span>
      </span>
      <Pagination className="mx-0 w-auto" aria-label="Страницы">
        <PaginationContent className="gap-2">
          <PaginationItem>
            {hasPrev ? (
              <Button asChild variant="outline" size="sm">
                {/* A page past the end steps back to the last real one rather than to another empty page. */}
                <Link href={hrefFor(Math.min(page - 1, lastPage))} rel="prev">
                  <ChevronLeft />
                  Назад
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                <ChevronLeft />
                Назад
              </Button>
            )}
          </PaginationItem>
          <PaginationItem>
            <span className="px-1 tabular-nums">
              Страница {page} из {lastPage}
            </span>
          </PaginationItem>
          <PaginationItem>
            {hasNext ? (
              <Button asChild variant="outline" size="sm">
                <Link href={hrefFor(page + 1)} rel="next">
                  Вперёд
                  <ChevronRight />
                </Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Вперёд
                <ChevronRight />
              </Button>
            )}
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
