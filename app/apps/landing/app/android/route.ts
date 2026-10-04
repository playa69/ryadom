import { connection } from 'next/server'
import { getWebEnv } from '@/lib/env'

/**
 * Short link for the direct Android build. Printed on paper and sent in messengers, so it stays
 * stable while the storage URL changes.
 */
export async function GET() {
  await connection()
  const env = getWebEnv()
  if (!env.androidApkUrl) return new Response('APK пока не опубликован', { status: 404 })
  return Response.redirect(env.androidApkUrl, 307)
}
