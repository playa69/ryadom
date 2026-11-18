// Optional source: token use and the number of model calls from the agent's Langfuse. Goes through
// logs/scripts/langfuse.py, which sends read-only requests from inside the agent pod with the pod's own keys (the admin
// kubectl command comes from RYADOM_KUBECTL_ADMIN). Only sums leave it: tokens by model and kind of call, calls per
// Moscow day; no people or sessions, since Langfuse also holds the conversations people asked not to save.
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

// Traces (one per model call) per hour; with ids, only the traces of those accounts.
export function tracesQuery({ from, to, only = null }) {
  return {
    view: 'traces',
    dimensions: [],
    metrics: [{ measure: 'count', aggregation: 'count' }],
    filters: only ? [{ column: 'userId', operator: 'any of', value: only, type: 'stringOptions' }] : [],
    timeDimension: { granularity: 'hour' },
    fromTimestamp: iso(from),
    toTimestamp: iso(to),
    config: { row_limit: 1000 },
  };
}

// Tokens of all calls per hour, without test and team accounts (same filter as langfuseQuery).
export function tokensQuery({ from, to, excluded = [] }) {
  return {
    view: 'observations',
    dimensions: [],
    metrics: [{ measure: 'totalTokens', aggregation: 'sum' }],
    filters: excluded.length ? [{ column: 'userId', operator: 'none of', value: excluded, type: 'stringOptions' }] : [],
    timeDimension: { granularity: 'hour' },
    fromTimestamp: iso(from),
    toTimestamp: iso(to),
    config: { row_limit: 1000 },
  };
}

const mskDay = (value) => {
  const at = Date.parse(String(value).replace(' ', 'T').replace(/(?<!Z)$/, 'Z'));
  return Number.isNaN(at) ? null : new Date(at + 3 * 3600_000).toISOString().slice(0, 10);
};

export function summarizeTokensByDay(body) {
  const byDay = {};
  for (const r of body?.data ?? []) {
    const day = mskDay(r.time_dimension);
    if (day) byDay[day] = (byDay[day] ?? 0) + n(r.sum_totalTokens);
  }
  return byDay;
}

// Calls per Moscow day: all traces minus those of test and team accounts. Subtracting keeps the calls without a
// person (voicing of fixed phrases), which a "none of" filter would drop.
export function summarizeTraces(all, test) {
  const byDay = {};
  const add = (body, sign) => {
    for (const r of body?.data ?? []) {
      const day = mskDay(r.time_dimension);
      if (!day) continue;
      byDay[day] = (byDay[day] ?? 0) + sign * n(r.count_count);
    }
  };
  add(all, 1);
  add(test, -1);
  return byDay;
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

function metrics(query) {
  let lastError;
  for (const python of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
    try {
      const out = execFileSync(python, [SCRIPT, 'metrics', JSON.stringify(query)], {
        encoding: 'utf8',
        timeout: 180_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return JSON.parse(out);
    } catch (error) {
      lastError = error;
      if (error.code !== 'ENOENT') break;
    }
  }
  const detail = String(lastError?.stderr || lastError?.message || lastError).trim().split('\n').pop();
  throw new Error(`Langfuse: ${detail.slice(0, 200)}`);
}

export function collectLangfuse({ from, to, excluded = null }) {
  const usage = summarizeLangfuse(metrics(langfuseQuery({ from, to, excluded: excluded ?? [] })), { testsExcluded: excluded != null });
  const all = metrics(tracesQuery({ from, to }));
  const test = excluded?.length ? metrics(tracesQuery({ from, to, only: excluded })) : null;
  const tokensByDay = summarizeTokensByDay(metrics(tokensQuery({ from, to, excluded: excluded ?? [] })));
  return { ...usage, tracesByDay: summarizeTraces(all, test), tokensByDay };
}
