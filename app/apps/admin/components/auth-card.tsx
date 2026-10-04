import { BrandMark } from '@/components/brand-mark'

/** A centred white card on the gray page: sign-in, the error screen and the root 404. */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: React.ReactNode
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-lg bg-gray-900 text-white">
            <BrandMark className="size-8" />
          </div>
          <h1 className="text-xl font-bold text-gray-900">{title}</h1>
          {description && <p className="mt-1 text-sm text-gray-600">{description}</p>}
        </div>
        {children}
      </div>
    </main>
  )
}
