import { Counter, Registry } from 'prom-client'

/**
 * Prometheus metrics of the API: counters without ids and texts (read by `GET /metrics`, which the public route
 * `/api` prefix of the ingress does not reach; Prometheus scrapes it inside the cluster).
 *
 * `self_check_crisis_total{test}` counts crisis answers of the tests inside the app (add-self-check-tests, D4). It is
 * the only trace of a crisis answer: no person, no account, no time of day, no answer. It is not an analytics event.
 */
export const metricsRegistry = new Registry()

export const selfCheckCrisisTotal = new Counter({
  name: 'self_check_crisis_total',
  help: 'Crisis answers in the tests inside the app, by test; no person is attached.',
  labelNames: ['test'] as const,
  registers: [metricsRegistry],
})
