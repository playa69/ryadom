import { redirect } from 'next/navigation'
import { appPath } from '@/lib/base-path'
import { clearAdminSession } from '@/lib/session'

/** POST only: a GET would let a foreign page log the admin out with an image tag. */
export async function POST() {
  await clearAdminSession()
  // A route handler's redirect() is sent as written, without the base path.
  redirect(appPath('/login'))
}
