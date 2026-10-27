import { resolveStand } from '../../../scripts/stand-ports.mjs'

/**
 * Where the screens are: the addresses of this worktree's stand (app/.stand.json, or the old fixed ports when
 * the worktree has no slot yet). The development stack by default, the e2e stack with `--stack e2e`; an explicit
 * --base, --agent or --mail still wins.
 */
export function standUrls(args) {
  const stand = resolveStand()
  return args.stack === 'e2e' ? stand.urls.e2e : stand.urls.dev
}
