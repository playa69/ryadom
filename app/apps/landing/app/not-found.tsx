import Link from 'next/link'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { Lead, PageTitle, pageButton, pageButtonLift, Section, WideMain } from './_doc/doc'

export default function NotFound() {
  return (
    <WideMain>
      <Section className="mx-auto max-w-[720px] py-[72px] max-[720.1px]:py-[30px]">
        <PageTitle>Такой страницы нет</PageTitle>
        <Lead>Возможно, ссылка устарела. Начните с главной.</Lead>
        <Button asChild className={cn(pageButton, pageButtonLift)}>
          <Link href="/">На главную</Link>
        </Button>
      </Section>
    </WideMain>
  )
}
