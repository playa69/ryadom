#!/usr/bin/env node
// HogQL against the PostHog project «Рядом» (EU cloud, project 300786) through its query API.
//   node hogql.mjs "<HogQL>" [--json]
//   node hogql.mjs -f query.sql [--json] [--set name=value ...] [--dry]
// The personal API key (scope query:read is enough) comes from POSTHOG_PERSONAL_API_KEY; it is never printed.
// POSTHOG_UI_HOST and POSTHOG_PROJECT_ID override the host and the project.
//
// Placeholders in the query text:
//   {{people}}  the standard filter of real people (posthog.mjs; the same text is in SKILL.md, keep them in step);
//   {{name}}    any other name, from --set name=value (dates in UTC, numbers).
// POSTHOG_EXCLUDE_PERSONS=<id prefix>,<id prefix> adds team accounts that are not marked `internal` yet to {{people}};
// the list is kept locally, not in the repository.
// --dry prints the final query and does not call PostHog (no key needed): to paste it into the browser console.
import { readFileSync } from 'node:fs';
import { fillQuery, runHogQL } from './posthog.mjs';

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

try {
  sql = fillQuery(sql, values);
} catch (error) {
  fail(error.message);
}

if (dry) {
  console.log(sql);
  process.exit(0);
}

let body;
try {
  body = await runHogQL(sql);
} catch (error) {
  console.error(error.message);
  process.exit(error.message.startsWith('POSTHOG_PERSONAL_API_KEY') ? 2 : 1);
}
if (json) {
  console.log(JSON.stringify({ columns: body.columns, results: body.results }, null, 1));
} else {
  console.log(body.columns.join('\t'));
  for (const row of body.results) console.log(row.map((v) => (typeof v === 'object' ? JSON.stringify(v) : v)).join('\t'));
}
// HogQL cuts results at 100 rows unless the query sets LIMIT itself.
if (body.results.length === 100 && !/\blimit\b/i.test(sql)) console.error('# 100 rows: the default limit, add LIMIT');
