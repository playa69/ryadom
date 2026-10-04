/** Liveness probe. The site has no dependencies, so being able to answer is the whole check. */
export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ status: 'ok' })
}
