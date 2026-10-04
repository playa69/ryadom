import { requireAdmin } from '@/lib/session'
import { adminEnv } from '@/lib/env'
import { AdminHeader } from './_components/admin-header'
import { AdminSidebar } from './_components/admin-sidebar'

/** Everything below this layout requires a session; the check is repeated in every action. */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin()
  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <AdminSidebar siteUrl={adminEnv().PUBLIC_WEB_URL} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AdminHeader email={session.email} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  )
}
