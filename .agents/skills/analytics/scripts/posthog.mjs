// Shared access to the PostHog project «Рядом» (EU cloud, project 300786): the real-people filter and a HogQL call.
// Used by hogql.mjs (ad hoc queries) and report.mjs (the daily summary), so the filter lives in one place.
// The personal API key (scope query:read is enough) comes from POSTHOG_PERSONAL_API_KEY; it is never printed.
// POSTHOG_UI_HOST and POSTHOG_PROJECT_ID override the host and the project.

// Not a person with a conversation: load test, team, tests, and events about nobody (a random id for every event,
// so uniq(person_id) would count the events, not the people). The same text is in SKILL.md, keep them in step.
export function peopleFilter() {
  // POSTHOG_EXCLUDE_PERSONS=<id prefix>,<id prefix> adds team accounts that are not marked `internal` yet;
  // the list is kept locally, not in the repository.
  const excluded = (process.env.POSTHOG_EXCLUDE_PERSONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (excluded.some((prefix) => !/^[0-9a-f-]{4,36}$/i.test(prefix))) {
    throw new Error('POSTHOG_EXCLUDE_PERSONS: comma-separated id prefixes, hex digits and dashes only');
  }
  return [
    'person_id NOT IN COHORT 275976',
    "coalesce(properties.app_env, '') NOT IN ('local', 'staging', 'development')",
    "coalesce(properties.traffic_type, 'real') NOT IN ('test', 'internal')",
    "event NOT IN ('safety_signal', 'sos_opened', 'hotline_called', 'password_reset_requested', 'account_deleted')",
    "NOT (event = 'cta_clicked' AND properties.cta = 'hotline')",
    ...excluded.map((prefix) => `toString(person_id) NOT LIKE '${prefix}%'`),
  ].join('\n  AND ');
}

// Replaces {{people}} with the filter and {{name}} with values[name]; an unknown name is an error.
export function fillQuery(sql, values = {}) {
  const all = { people: peopleFilter(), ...values };
  return sql.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in all)) throw new Error(`no value for {{${name}}}: pass --set ${name}=…`);
    return all[name];
  });
}

// Runs HogQL and returns { columns, results }. Throws with the HTTP status and PostHog's message on failure.
export async function runHogQL(sql) {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!key) throw new Error('POSTHOG_PERSONAL_API_KEY is not set: a personal API key with query:read, from the administrator');
  const host = (process.env.POSTHOG_UI_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
  const project = process.env.POSTHOG_PROJECT_ID || '300786';
  const response = await fetch(`${host}/api/environments/${project}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql }, refresh: 'force_blocking' }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.detail ?? JSON.stringify(body).slice(0, 500)}`);
  return { columns: body.columns, results: body.results };
}

// Rows as objects keyed by column name.
export function rowsOf({ columns, results }) {
  return results.map((row) => Object.fromEntries(columns.map((name, i) => [name, row[i]])));
}
