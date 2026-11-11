// Optional source: token use of all model calls from the agent's Langfuse. Goes through logs/scripts/langfuse.py,
// which sends read-only requests from inside the agent pod with the pod's own keys (the admin kubectl command comes
// from RYADOM_KUBECTL_ADMIN). Only sums by model and kind of call leave it: no people, sessions or call counts, since
// Langfuse also holds the conversations people asked not to save.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', '..', 'logs', 'scripts', 'langfuse.py');

export const langfuseConfigured = () => Boolean(process.env.RYADOM_KUBECTL_ADMIN);

const KINDS = [
  [/^(live_turn_|text_turn)/, 'разговор'],
  [/^mood_classify/, 'настроение'],
  [/^dialog_recap/, 'итог разговора'],
  [/^memory/, 'память'],
  [/^weekly_digest/, 'итог недели'],
  [/_tts_phrase$/, 'озвучка фраз'],
  [/_session_open$/, 'открытие сессии'],
];
const kindOf = (name) => KINDS.find(([re]) => re.test(name || ''))?.[1] ?? (name || 'без имени');
const n = (v) => Number(v) || 0;
const iso = (utc) => `${utc.replace(' ', 'T')}Z`;

// from and to: UTC timestamps 'YYYY-MM-DD HH:MM:SS' (to is exclusive); excluded: ids of test and team accounts.
// The "none of" filter also drops calls without a person (voicing of fixed phrases, a few mood calls): they carry next
// to no tokens.
export function langfuseQuery({ from, to, excluded = [] }) {
  return {
    view: 'observations',
    dimensions: [{ field: 'providedModelName' }, { field: 'traceName' }],
    metrics: [
      { measure: 'inputTokens', aggregation: 'sum' },
      { measure: 'outputTokens', aggregation: 'sum' },
    ],
    filters: excluded.length ? [{ column: 'userId', operator: 'none of', value: excluded, type: 'stringOptions' }] : [],
    fromTimestamp: iso(from),
    toTimestamp: iso(to),
    config: { row_limit: 1000 },
  };
}

export function summarizeLangfuse(body, { testsExcluded }) {
  const groups = new Map();
  for (const r of body.data ?? []) {
    const model = r.providedModelName || 'без модели';
    const task = kindOf(r.traceName);
    const key = `${model}|${task}`;
    if (!groups.has(key)) groups.set(key, { model, task, input: 0, output: 0 });
    const g = groups.get(key);
    g.input += n(r.sum_inputTokens);
    g.output += n(r.sum_outputTokens);
  }
  const rows = [...groups.values()].filter((r) => r.input + r.output > 0).sort((a, b) => b.input + b.output - (a.input + a.output));
  return { rows, total: rows.reduce((a, r) => a + r.input + r.output, 0), testsExcluded };
}

export function collectLangfuse({ from, to, excluded = null }) {
  const query = JSON.stringify(langfuseQuery({ from, to, excluded: excluded ?? [] }));
  let lastError;
  for (const python of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
    try {
      const out = execFileSync(python, [SCRIPT, 'metrics', query], {
        encoding: 'utf8',
        timeout: 180_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return summarizeLangfuse(JSON.parse(out), { testsExcluded: excluded != null });
    } catch (error) {
      lastError = error;
      if (error.code !== 'ENOENT') break;
    }
  }
  const detail = String(lastError?.stderr || lastError?.message || lastError).trim().split('\n').pop();
  throw new Error(`Langfuse: ${detail.slice(0, 200)}`);
}
