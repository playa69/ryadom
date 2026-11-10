// Prometheus of the cluster for the report: token use of the agent's models over the report period. Read-only.
// Goes through logs/scripts/monitoring.py, which opens a short port-forward with the kubectl command from
// RYADOM_KUBECTL_ADMIN (admin kubeconfig). Instant queries are pinned to the end of the period with `offset`, so a
// 09:00 run counts the same full days as PostHog. Prometheus keeps 14 days: longer periods are cut.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MONITORING = join(here, '..', '..', 'logs', 'scripts', 'monitoring.py');

export const prometheusConfigured = () => Boolean(process.env.RYADOM_KUBECTL_ADMIN);

function prom(query) {
  let lastError;
  for (const python of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
    try {
      const out = execFileSync(python, [MONITORING, 'prom', query, '--raw'], {
        encoding: 'utf8',
        timeout: 180_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const body = JSON.parse(out);
      if (body.status !== 'success') throw new Error(`Prometheus: ${body.error ?? body.status}`);
      return body.data.result;
    } catch (error) {
      lastError = error;
      if (error.code !== 'ENOENT') break;
    }
  }
  const detail = String(lastError?.stderr || lastError?.message || lastError).trim().split('\n').pop();
  throw new Error(`Prometheus: ${detail.slice(0, 200)}`);
}

// toMs: the end of the period (exclusive), days: its length.
export function collectPrometheus({ toMs, days }) {
  const offset = Math.max(0, Math.round((Date.now() - toMs) / 1000));
  const range = `[${Math.min(days, 14)}d] offset ${offset}s`;
  const usage = prom(`sum by (model, task, direction) (increase(agent_model_usage_total{unit="tokens"}${range}))`);
  const models = new Map();
  for (const { metric, value } of usage) {
    const key = `${metric.model ?? '?'}|${metric.task ?? ''}`;
    if (!models.has(key)) models.set(key, { model: metric.model ?? '?', task: metric.task ?? '', input: 0, output: 0 });
    const row = models.get(key);
    const tokens = Math.round(Number(value?.[1]) || 0);
    if (metric.direction === 'output') row.output += tokens;
    else row.input += tokens;
  }
  const rows = [...models.values()].filter((r) => r.input + r.output > 0).sort((a, b) => b.input + b.output - (a.input + a.output));
  if (!rows.length) {
    // An empty answer is not «zero tokens»: say what Prometheus has instead, so the next run shows the cause.
    const names = prom('count by (__name__) ({__name__=~"agent_model.*"})').map((s) => s.metric.__name__);
    const units = prom('count by (unit) (agent_model_usage_total)').map((s) => s.metric.unit ?? '∅');
    throw new Error(
      `no token rows for the period; agent_model* series now: ${names.join(', ') || 'none'}` +
        (units.length ? `; unit values: ${units.join(', ')}` : ''),
    );
  }
  return { models: rows, total: rows.reduce((a, r) => a + r.input + r.output, 0), days: Math.min(days, 14) };
}
