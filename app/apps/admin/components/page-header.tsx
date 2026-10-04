export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
      {children && <p className="mt-1 text-gray-600">{children}</p>}
    </div>
  )
}
