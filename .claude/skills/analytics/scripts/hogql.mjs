#!/usr/bin/env node
// HogQL against the PostHog project «Рядом» (EU cloud, project 300786) through its query API.
//   node hogql.mjs "<HogQL>" [--json]
//   node hogql.mjs -f query.sql [--json] [--set name=value ...] [--dry]
// The personal API key (scope query:read is enough) comes from POSTHOG_PERSONAL_API_KEY; it is never printed.
// POSTHOG_UI_HOST and POSTHOG_PROJECT_ID override the host and the project.
//
// Placeholders in the query text:
//   {{people}}  the standard filter of real people (the same text is in SKILL.md, keep them in step);
//   {{name}}    any other name, from --set name=value (dates in UTC, numbers).
// POSTHOG_EXCLUDE_PERSONS=<id prefix>,<id prefix> adds team accounts that are not marked `internal` yet to {{people}};
// the list is kept locally, not in the repository.
// --dry prints the final query and does not call PostHog (no key needed): to paste it into the browser console.
import { readFileSync } from 'node:fs';

const fail = (message) => {
  console.error(message);
  process.exit(2);
};

const args = process.argv.slice(2);
const json = args.includes('--json');
const dry = args.includes('--dry');
const values = {};
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json' || args[i] === '--dry') continue;
  if (args[i] === '--set') {
    const [name, ...value] = (args[++i] ?? '').split('=');
    if (!/^\w+$/.test(name ?? '') || !value.length) fail('--set expects name=value');
    if (!/^[\w .:+-]+$/.test(value.join('='))) fail(`--set ${name}: only letters, digits, space and . : + - are allowed`);
    values[name] = value.join('=');
  } else {
    rest.push(args[i]);
  }
}
let sql = rest[0] === '-f' ? readFileSync(rest[1], 'utf8') : rest[0];
if (!sql) {
  console.error('usage: node hogql.mjs "<HogQL>" [--json] | -f query.sql [--json] [--set name=value ...] [--dry]');
  process.exit(2);
}

// Not a person with a conversation: load test, team, tests, and events about nobody (a random id for every event,
// so uniq(person_id) would count the events, not the people).
const excluded = (process.env.POSTHOG_EXCLUDE_PERSONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (excluded.some((prefix) => !/^[0-9a-f-]{4,36}$/i.test(prefix))) {
  fail('POSTHOG_EXCLUDE_PERSONS: comma-separated id prefixes, hex digits and dashes only');
}
values.people = [
  'person_id NOT IN COHORT 275976',
  "coalesce(properties.app_env, '') NOT IN ('local', 'staging', 'development')",
  "coalesce(properties.traffic_type, 'real') NOT IN ('test', 'internal')",
  "event NOT IN ('safety_signal', 'sos_opened', 'hotline_called', 'password_reset_requested', 'account_deleted')",
  "NOT (event = 'cta_clicked' AND properties.cta = 'hotline')",
  ...excluded.map((prefix) => `toString(person_id) NOT LIKE '${prefix}%'`),
].join('\n  AND ');

sql = sql.replace(/\{\{(\w+)\}\}/g, (_, name) => {
  if (!(name in values)) fail(`no value for {{${name}}}: pass --set ${name}=…`);
  return values[name];
});

if (dry) {
  console.log(sql);
  process.exit(0);
}

const key = process.env.POSTHOG_PERSONAL_API_KEY;
if (!key) fail('POSTHOG_PERSONAL_API_KEY is not set: a personal API key with query:read, from the administrator');
const host = (process.env.POSTHOG_UI_HOST || 'https://eu.posthog.com').replace(/\/$/, '');
const project = process.env.POSTHOG_PROJECT_ID || '300786';

const response = await fetch(`${host}/api/environments/${project}/query/`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql }, refresh: 'force_blocking' }),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`HTTP ${response.status}: ${body.detail ?? JSON.stringify(body).slice(0, 500)}`);
  process.exit(1);
}
if (json) {
  console.log(JSON.stringify({ columns: body.columns, results: body.results }, null, 1));
} else {
  console.log(body.columns.join('\t'));
  for (const row of body.results) console.log(row.map((v) => (typeof v === 'object' ? JSON.stringify(v) : v)).join('\t'));
}
// HogQL cuts results at 100 rows unless the query sets LIMIT itself.
if (body.results.length === 100 && !/\blimit\b/i.test(sql)) console.error('# 100 rows: the default limit, add LIMIT');
