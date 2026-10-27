#!/usr/bin/env node
// HogQL against the PostHog project "Ryadom" (EU cloud, project 300786) through its query API.
//   node hogql.mjs "<HogQL>" [--json]
//   node hogql.mjs -f query.sql [--json]
// The personal API key (scope query:read is enough) comes from POSTHOG_PERSONAL_API_KEY; it is never printed.
// POSTHOG_UI_HOST and POSTHOG_PROJECT_ID override the host and the project.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const rest = args.filter((a) => a !== '--json');
const sql = rest[0] === '-f' ? readFileSync(rest[1], 'utf8') : rest[0];
if (!sql) {
  console.error('usage: node hogql.mjs "<HogQL>" [--json] | -f query.sql [--json]');
  process.exit(2);
}
const key = process.env.POSTHOG_PERSONAL_API_KEY;
if (!key) {
  console.error('POSTHOG_PERSONAL_API_KEY is not set: a personal API key with query:read, from the administrator');
  process.exit(2);
}
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
