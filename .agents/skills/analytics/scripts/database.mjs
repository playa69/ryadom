// The production databases for the report, read-only: true totals (people who opted out of analytics are not in
// PostHog), the token use of the agent's models per conversation, and the state of features (memory on, diary, tests,
// push). Only aggregates: no texts, no ids leave the query.
// Goes through db/scripts/query.py, which runs psql in the primary pod of the CNPG cluster in a read-only session; the
// kubectl command (admin kubeconfig) comes from RYADOM_KUBECTL_ADMIN.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const QUERY = join(here, '..', '..', 'db', 'scripts', 'query.py');

export const databaseConfigured = () => Boolean(process.env.RYADOM_KUBECTL_ADMIN);

// psql --csv: a header row, then rows; a field is quoted when it holds a comma, a quote or a newline.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.length > 1 || r[0] !== '');
  return (body ?? []).map((r) => Object.fromEntries((header ?? []).map((name, i) => [name, r[i]])));
}

function sql(database, query) {
  let lastError;
  for (const python of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
    try {
      const out = execFileSync(python, [QUERY, database, query, '--csv'], {
        encoding: 'utf8',
        timeout: 180_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return parseCsv(out);
    } catch (error) {
      lastError = error;
      if (error.code !== 'ENOENT') break;
    }
  }
  const detail = String(lastError?.stderr || lastError?.message || lastError).trim().split('\n').pop();
  throw new Error(`база: ${detail.slice(0, 200)}`);
}

const n = (v) => Number(v) || 0;

// Test and team accounts: the agent's tables and Langfuse only know user ids, so they are left out by id.
export function testAccountIds() {
  return sql('app', "SELECT id FROM users WHERE properties->>'traffic_type' IN ('test', 'internal')")
    .map((r) => r.id)
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
}

// from and to: UTC timestamps 'YYYY-MM-DD HH:MM:SS' (to is exclusive).
export function collectDatabase({ from, to, excluded = testAccountIds() }) {
  const since = `'${from}+00'::timestamptz`;
  const until = `'${to}+00'::timestamptz`;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(to)) {
    throw new Error('база: bad period');
  }

  const notExcluded = (column) =>
    excluded.length ? `${column} NOT IN (${excluded.map((id) => `'${id}'`).join(', ')})` : 'TRUE';

  const app = sql('app', `
WITH real AS (
  SELECT * FROM users WHERE coalesce(properties->>'traffic_type', 'real') NOT IN ('test', 'internal')
), fresh AS (
  SELECT * FROM real WHERE created_at >= ${since} AND created_at < ${until}
)
SELECT
  (SELECT count(*) FROM fresh) AS accounts_new,
  (SELECT count(*) FROM fresh WHERE email IS NOT NULL) AS accounts_new_email,
  (SELECT count(*) FROM fresh WHERE telegram_id IS NOT NULL) AS accounts_new_telegram,
  (SELECT count(*) FROM fresh WHERE email IS NULL AND telegram_id IS NULL) AS accounts_new_anonymous,
  (SELECT count(*) FROM fresh WHERE properties->'analytics'->>'optOut' = 'true') AS optout_new,
  (SELECT count(*) FROM real WHERE NOT is_deleted) AS accounts_total,
  (SELECT count(*) FROM real WHERE NOT is_deleted AND properties->'analytics'->>'optOut' = 'true') AS optout_total,
  (SELECT count(DISTINCT m.user_id) FROM mood_checkins m JOIN real r ON r.id = m.user_id
     WHERE m.created_at >= ${since} AND m.created_at < ${until}) AS mood_people,
  (SELECT count(*) FROM mood_checkins m JOIN real r ON r.id = m.user_id
     WHERE m.created_at >= ${since} AND m.created_at < ${until}) AS mood_checkins,
  (SELECT count(DISTINCT s.user_id) FROM self_check_results s JOIN real r ON r.id = s.user_id
     WHERE s.created_at >= ${since} AND s.created_at < ${until}) AS tests_people,
  (SELECT count(DISTINCT p.user_id) FROM push_subscriptions p JOIN real r ON r.id = p.user_id
     WHERE NOT r.is_deleted) AS push_people`)[0] ?? {};

  // Agent times are ISO text in UTC.
  const activity = sql('agent', `
WITH um AS (
  SELECT m.dialog_id, d.user_id, m.role, m.audio_seconds, m.created_at::timestamptz AS at
  FROM messages m JOIN dialogs d ON d.id = m.dialog_id
  WHERE m.created_at::timestamptz >= ${since} AND m.created_at::timestamptz < ${until} AND ${notExcluded('d.user_id')}
)
SELECT
  count(*) FILTER (WHERE role = 'user') AS user_messages,
  count(DISTINCT user_id) FILTER (WHERE role = 'user') AS speakers,
  count(DISTINCT dialog_id) FILTER (WHERE role = 'user') AS dialogs,
  count(DISTINCT (user_id, (at AT TIME ZONE 'Europe/Moscow')::date)) FILTER (WHERE role = 'user') AS person_days,
  round(coalesce(sum(audio_seconds) FILTER (WHERE role = 'user'), 0)) AS user_audio_seconds,
  round(coalesce(sum(audio_seconds) FILTER (WHERE role = 'assistant'), 0)) AS agent_audio_seconds
FROM um`)[0] ?? {};

  // Token use; dialog_id is empty once a dialog was erased, and such rows still count.
  const usage = sql('agent', `
SELECT mu.model, mu.task, mu.direction, round(sum(mu.amount)) AS amount, count(DISTINCT mu.dialog_id) AS dialogs
FROM model_usage mu LEFT JOIN dialogs d ON d.id = mu.dialog_id
WHERE mu.unit = 'tokens' AND mu.created_at::timestamptz >= ${since} AND mu.created_at::timestamptz < ${until}
  AND (d.user_id IS NULL OR ${notExcluded('d.user_id')})
GROUP BY 1, 2, 3`);
  const usageDialogs = n(sql('agent', `
SELECT count(DISTINCT mu.dialog_id) AS dialogs
FROM model_usage mu LEFT JOIN dialogs d ON d.id = mu.dialog_id
WHERE mu.unit = 'tokens' AND mu.dialog_id IS NOT NULL
  AND mu.created_at::timestamptz >= ${since} AND mu.created_at::timestamptz < ${until}
  AND (d.user_id IS NULL OR ${notExcluded('d.user_id')})`)[0]?.dialogs);

  // Per Moscow day: messages of people, token use, conversations with token use.
  const perDay = sql('agent', `
WITH m AS (
  SELECT (m.created_at::timestamptz AT TIME ZONE 'Europe/Moscow')::date AS day, count(*) AS user_messages
  FROM messages m JOIN dialogs d ON d.id = m.dialog_id
  WHERE m.role = 'user' AND m.created_at::timestamptz >= ${since} AND m.created_at::timestamptz < ${until}
    AND ${notExcluded('d.user_id')}
  GROUP BY 1
), u AS (
  SELECT (mu.created_at::timestamptz AT TIME ZONE 'Europe/Moscow')::date AS day, round(sum(mu.amount)) AS tokens,
    count(DISTINCT mu.dialog_id) AS dialogs
  FROM model_usage mu LEFT JOIN dialogs d ON d.id = mu.dialog_id
  WHERE mu.unit = 'tokens' AND mu.created_at::timestamptz >= ${since} AND mu.created_at::timestamptz < ${until}
    AND (d.user_id IS NULL OR ${notExcluded('d.user_id')})
  GROUP BY 1
)
SELECT to_char(coalesce(m.day, u.day), 'YYYY-MM-DD') AS day, coalesce(m.user_messages, 0) AS user_messages,
  coalesce(u.tokens, 0) AS tokens, coalesce(u.dialogs, 0) AS dialogs
FROM m FULL JOIN u ON m.day = u.day
ORDER BY 1`);

  const memory = sql('agent', `SELECT count(*) FILTER (WHERE enabled) AS memory_on FROM memory_settings WHERE ${notExcluded('user_id')}`)[0] ?? {};

  const models = new Map();
  for (const r of usage) {
    const key = `${r.model}|${r.task}`;
    if (!models.has(key)) models.set(key, { model: r.model, task: r.task, input: 0, output: 0 });
    const row = models.get(key);
    if (r.direction === 'output') row.output += n(r.amount);
    else row.input += n(r.amount);
  }
  const rows = [...models.values()].filter((r) => r.input + r.output > 0).sort((a, b) => b.input + b.output - (a.input + a.output));

  return {
    excludedAccounts: excluded.length,
    app: Object.fromEntries(Object.entries(app).map(([k, v]) => [k, n(v)])),
    activity: Object.fromEntries(Object.entries(activity).map(([k, v]) => [k, n(v)])),
    memoryOn: n(memory.memory_on),
    daily: Object.fromEntries(perDay.map((r) => [r.day, { userMessages: n(r.user_messages), tokens: n(r.tokens), dialogs: n(r.dialogs) }])),
    usage: { models: rows, total: rows.reduce((a, r) => a + r.input + r.output, 0), dialogs: usageDialogs },
  };
}
