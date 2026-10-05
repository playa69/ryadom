/** What stands in for the address when nothing trustworthy says where the request came from. */
export const UNKNOWN_CLIENT_IP = 'unknown'

/**
 * The address of the client behind reverse proxies.
 *
 * Every trusted proxy appends the address it accepted the connection from to the END of
 * `X-Forwarded-For`, and whatever the client sent itself stays at the start. Reading the first entry
 * therefore leaves the choice of the address to the client: a different made-up value on every
 * request gets a fresh rate-limit bucket each time. The address that can be trusted is the one our
 * outermost proxy appended, `trustedHops` entries from the end: 1 behind a single ingress or
 * gateway (the Istio gateway in the cluster), 2 with a CDN or balancer in front of it.
 *
 * `trustedHops` of 0 means no trusted proxy: every forwarding header is client-controlled and is
 * ignored, so the result is the same for everyone. If the header has fewer entries than the number
 * of hops (a proxy that does not append, or a request that skipped one), the first entry is used.
 */
export function resolveClientIp(
  forwardedFor: string | null | undefined,
  realIp: string | null | undefined,
  trustedHops: number,
): string {
  if (trustedHops <= 0) return UNKNOWN_CLIENT_IP

  const entries = (forwardedFor ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (entries.length > 0) return entries[Math.max(0, entries.length - trustedHops)]!

  return realIp?.trim() || UNKNOWN_CLIENT_IP
}
