import { redirect } from 'next/navigation'
import { clearAdminSession } from '@/lib/session'

/** POST only: a GET would let a foreign page log the admin out with an image tag. */
export async function POST() {
  await clearAdminSession()
  redirect('/login')
}
