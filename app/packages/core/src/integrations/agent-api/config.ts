import { getEnv } from '../../config'

/** Agent call settings. Read on every request because tests stub env. */
export const agentApiConfig = {
  get baseUrl(): string {
    return getEnv().AGENT_API_URL
  },
  get token(): string | undefined {
    return getEnv().AGENT_API_TOKEN
  },
  get timeoutMs(): number {
    return getEnv().AGENT_TIMEOUT_MS
  },
}
