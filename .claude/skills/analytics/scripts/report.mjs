#!/usr/bin/env node
// The «Сводка Рядом» report for a Multica issue: the summary goes into the issue description (Markdown: an issue
// description is an editor, so no html blocks or title tooltips there) and the detail into its first comment as an
// inline ```html block, which Multica renders in place.
//   node report.mjs [--to YYYY-MM-DD] [--days 7] [--out DIR]   query the sources and write DIR/{title.txt,
//                                                              description.md,detail-comment.md,detail.html,report.json}
//   node report.mjs --queries [--to …] [--days …]               print the filled PostHog queries as JSON (no key needed)
//   node report.mjs --data results.json [--to …] [--days …]     render from saved results {name: {columns, results}}
// The period is --days full Moscow days ending before --to (default: today in Moscow), so a 09:00 run covers the
// last week up to yesterday. Every number is computed here; the agent only replaces the <!-- ГЛАВНОЕ --> line of
// description.md with its reading of report.json, so the figures never pass through a model.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDashboard, dashboardConfigured } from './dashboard.mjs';
import { collectDatabase, databaseConfigured, testAccountIds } from './database.mjs';
import { collectLangfuse, langfuseConfigured } from './langfuse.mjs';
import { collectMetrika, metrikaConfigured } from './metrika.mjs';
import { fillQuery, rowsOf, runHogQL } from './posthog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fail = (message) => {
  console.error(message);
  process.exit(2);
};

// ---------- arguments and period ----------
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const DAY_MS = 86_400_000;
const mskToday = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const toDate = opt('--to', mskToday);
const days = Number(opt('--days', '7'));
if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) fail('--to expects YYYY-MM-DD (a Moscow date, exclusive)');
if (!Number.isInteger(days) || days < 1 || days > 31) fail('--days expects 1…31');
const outDir = resolve(opt('--out', 'analytics-report'));

// Moscow has no daylight saving time since 2014: midnight there is 21:00 UTC of the previous day.
const mskMidnight = (date) => new Date(Date.parse(`${date}T00:00:00+03:00`));
const utc = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const shiftDate = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const fromDate = shiftDate(toDate, -days);
const lastDate = shiftDate(toDate, -1);
const ddmm = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
const periodLabel =
  fromDate.slice(5, 7) === lastDate.slice(5, 7)
    ? `${fromDate.slice(8, 10)}–${ddmm(lastDate)}`
    : `${ddmm(fromDate)}–${ddmm(lastDate)}`;

const values = {
  from: utc(mskMidnight(fromDate)),
  to: utc(mskMidnight(toDate)),
  prev_from: utc(mskMidnight(shiftDate(toDate, -2 * days))),
  ret_to: utc(new Date(mskMidnight(toDate).getTime() - DAY_MS)),
  // dialog_turn exists since the evening of 13.10.2026; people who spoke earlier have no per-reply events.
  epoch: '2026-10-13 21:00:00',
};

// ---------- queries ----------
const DIALOGS = `SELECT person_id, properties.dialog_id AS dlg, min(timestamp) AS t0, count() AS r
    FROM events WHERE event = 'dialog_turn' AND {{people}} AND timestamp < toDateTime('{{to}}')
    GROUP BY person_id, dlg`;
const WINDOW = `timestamp >= toDateTime('{{from}}') AND timestamp < toDateTime('{{to}}')`;

const QUERIES = {
  // Devices first seen in the period: first-touch channel, device type and how far each got.
  cohort: `
WITH p AS (
  SELECT person_id,
    min(timestamp) AS first_seen,
    countIf(event = '$pageview') AS c_pv,
    argMinIf(coalesce(properties.$session_entry_utm_source, ''), timestamp, event = '$pageview') AS utm_s,
    argMinIf(coalesce(properties.$session_entry_utm_campaign, ''), timestamp, event = '$pageview') AS utm_c,
    argMinIf(coalesce(properties.$device_type, ''), timestamp, event = '$pageview') AS dev,
    countIf(event = '$pageview' AND properties.app_platform = 'landing') AS c_lp,
    countIf(event = 'app_opened' OR (event = '$pageview' AND properties.app_platform != 'landing')) AS c_app,
    countIf(event = 'account_created') AS c_acc,
    countIf(event = 'consents_accepted') AS c_cons,
    countIf(event = 'dialog_started') AS c_ds,
    countIf(event = 'dialog_turn') AS c_turns,
    uniqIf(toDate(toTimeZone(timestamp, 'Europe/Moscow')), event = 'dialog_turn') AS c_days
  FROM events
  WHERE {{people}} AND timestamp < toDateTime('{{to}}')
  GROUP BY person_id
  HAVING first_seen >= toDateTime('{{from}}')
), d AS (
  SELECT person_id, max(r) AS best, argMin(r, t0) AS fdt FROM (${DIALOGS}) GROUP BY person_id
)
SELECT if(c_pv = 0, '?', utm_s) AS utm_source, if(c_pv = 0, '', utm_c) AS utm_campaign, if(c_pv = 0, '', dev) AS device,
  count() AS visitors, countIf(c_lp > 0) AS landing, countIf(c_app > 0) AS product, countIf(c_acc > 0) AS account,
  countIf(c_cons > 0) AS consents, countIf(c_ds > 0) AS dialog, countIf(c_turns > 0) AS spoke, countIf(d.best >= 3) AS d3,
  countIf(c_days >= 2) AS returned, sum(c_turns) AS turns, groupArrayIf(d.fdt, c_turns > 0) AS first_dialogs
FROM p LEFT JOIN d ON p.person_id = d.person_id
GROUP BY utm_source, utm_campaign, device
ORDER BY visitors DESC
LIMIT 500`,

  // DAU, replies and people who used voice, per Moscow day. The team's DAU, users and active accounts come from the
  // dashboard (dashboard.mjs); this one is PostHog's, for shares and slices.
  daily: `
SELECT toString(day) AS day, count() AS dau, sum(n) AS turns, countIf(v > 0) AS voice FROM (
  SELECT toDate(toTimeZone(timestamp, 'Europe/Moscow')) AS day, person_id, count() AS n,
    countIf(properties.input = 'voice') AS v
  FROM events WHERE event = 'dialog_turn' AND {{people}} AND ${WINDOW}
  GROUP BY day, person_id)
GROUP BY day
ORDER BY day
LIMIT 100`,

  // People with 3+ and 10+ replies in at least one Moscow day of the period: goals 3 and 4 of Metrika on PostHog's side.
  goalPeople: `
SELECT uniqIf(person_id, n >= 3) AS polz3, uniqIf(person_id, n >= 10) AS dau10 FROM (
  SELECT person_id, toDate(toTimeZone(timestamp, 'Europe/Moscow')) AS day, count() AS n
  FROM events WHERE event = 'dialog_turn' AND {{people}} AND ${WINDOW}
  GROUP BY person_id, day)`,

  // Devices that pressed a landing button into the product: goal 1 of Metrika on PostHog's side.
  openApp: `
SELECT uniq(person_id) AS devices
FROM events
WHERE ((event = 'cta_clicked' AND properties.cta = 'open_web_app') OR event = 'store_link_clicked')
  AND {{people}} AND ${WINDOW}`,

  // People whose first reply ever fell on each day: dialogs of 3+ replies, length of the first dialog, and how many
  // of them came back on another day before the end of the period.
  newSpeakers: `
WITH f AS (
  SELECT person_id, min(t0) AS ft, max(r) AS best, argMin(r, t0) AS fdt FROM (${DIALOGS}) GROUP BY person_id
), n AS (
  SELECT person_id, uniq(toDate(toTimeZone(timestamp, 'Europe/Moscow'))) AS nd
  FROM events WHERE event = 'dialog_turn' AND {{people}} AND timestamp < toDateTime('{{to}}')
  GROUP BY person_id
)
SELECT toString(toDate(toTimeZone(f.ft, 'Europe/Moscow'))) AS day, count() AS new_speakers, countIf(f.best >= 3) AS new_d3,
  countIf(n.nd >= 2) AS returned, groupArray(f.fdt) AS first_dialogs
FROM f LEFT JOIN n ON f.person_id = n.person_id
WHERE f.ft >= toDateTime('{{from}}')
GROUP BY day
ORDER BY day
LIMIT 100`,

  // Devices first seen on each day and how many of them spoke: the cohort funnel split by day.
  cohortDaily: `
SELECT toString(toDate(toTimeZone(first_seen, 'Europe/Moscow'))) AS day, count() AS visitors, countIf(c_turns > 0) AS spoke
FROM (
  SELECT person_id, min(timestamp) AS first_seen, countIf(event = 'dialog_turn') AS c_turns
  FROM events
  WHERE {{people}} AND timestamp < toDateTime('{{to}}')
  GROUP BY person_id
  HAVING first_seen >= toDateTime('{{from}}'))
GROUP BY day
ORDER BY day
LIMIT 100`,

  // People denied the microphone per Moscow day.
  micDaily: `
SELECT toString(toDate(toTimeZone(timestamp, 'Europe/Moscow'))) AS day, uniq(person_id) AS people
FROM events
WHERE {{people}} AND event = 'voice_problem' AND properties.reason = 'permission_denied' AND ${WINDOW}
GROUP BY day
ORDER BY day
LIMIT 100`,

  wau: `
SELECT uniqIf(person_id, timestamp >= toDateTime('{{from}}')) AS wau, uniqIf(person_id, timestamp < toDateTime('{{from}}')) AS wau_prev
FROM events
WHERE event = 'dialog_turn' AND {{people}} AND timestamp >= toDateTime('{{prev_from}}') AND timestamp < toDateTime('{{to}}')`,

  // Everyone who spoke in the period: voice use and live errors.
  speakers: `
SELECT count() AS speakers, countIf(v > 0) AS used_voice, sum(t) AS turns, sum(v) AS voice_turns, sum(dl) AS dialogs
FROM (
  SELECT person_id,
    countIf(event = 'dialog_turn') AS t,
    countIf(event = 'dialog_turn' AND properties.input = 'voice') AS v,
    uniqIf(properties.dialog_id, event = 'dialog_turn') AS dl
  FROM events
  WHERE {{people}} AND event = 'dialog_turn' AND ${WINDOW}
  GROUP BY person_id
  HAVING t > 0)`,

  // People denied the microphone, for the voice tile. It keeps the name and the rows of the former quality query
  // (kind, people), so responses saved for that query still render with --data.
  quality: `
SELECT concat('voice:', coalesce(toString(properties.reason), '')) AS kind, uniq(person_id) AS people
FROM events
WHERE {{people}} AND event = 'voice_problem' AND properties.reason = 'permission_denied' AND ${WINDOW}
GROUP BY kind
LIMIT 10`,

  accounts: `
SELECT count() AS accounts
FROM events
WHERE event = 'account_created' AND {{people}} AND ${WINDOW}`,

  // Everyone who first spoke since dialog_turn exists and at least a day before the end: what goes with coming back.
  retention: `
WITH t AS (
  SELECT person_id, min(timestamp) AS ft, uniq(toDate(toTimeZone(timestamp, 'Europe/Moscow'))) AS n_days,
    count() AS n_turns, countIf(properties.input = 'voice') AS n_voice
  FROM events WHERE event = 'dialog_turn' AND {{people}} AND timestamp < toDateTime('{{to}}')
  GROUP BY person_id
), fd AS (
  SELECT person_id, argMin(r, t0) AS fdt FROM (${DIALOGS}) GROUP BY person_id
), x AS (
  SELECT person_id, countIf(event = 'memory_enabled') AS n_mem,
    countIf(event IN ('mood_checked_in', 'diary_opened', 'self_check_completed')) AS n_well
  FROM events
  WHERE {{people}} AND event IN ('memory_enabled', 'mood_checked_in', 'diary_opened', 'self_check_completed')
    AND timestamp < toDateTime('{{to}}')
  GROUP BY person_id
)
SELECT multiIf(fd.fdt < 3, 'fd1', fd.fdt < 8, 'fd3', fd.fdt < 15, 'fd8', fd.fdt < 30, 'fd15', 'fd30') AS first_dialog,
  multiIf(t.n_voice = 0, 'text', t.n_voice = t.n_turns, 'voice', 'mixed') AS input,
  if(x.n_mem > 0, 1, 0) AS memory, if(x.n_well > 0, 1, 0) AS wellbeing,
  count() AS people, countIf(t.n_days >= 2) AS returned
FROM t LEFT JOIN fd ON t.person_id = fd.person_id LEFT JOIN x ON t.person_id = x.person_id
WHERE t.ft >= toDateTime('{{epoch}}') AND t.ft <= toDateTime('{{ret_to}}')
GROUP BY first_dialog, input, memory, wellbeing
LIMIT 500`,
};

const filled = Object.fromEntries(Object.entries(QUERIES).map(([name, sql]) => [name, fillQuery(sql, values)]));
if (args.includes('--queries')) {
  console.log(JSON.stringify(filled, null, 1));
  process.exit(0);
}

let raw;
const dataFile = opt('--data');
if (dataFile) {
  raw = JSON.parse(readFileSync(dataFile, 'utf8'));
} else {
  raw = {};
  try {
    for (const [name, sql] of Object.entries(filled)) raw[name] = await runHogQL(sql);
  } catch (error) {
    console.error(error.message);
    process.exit(error.message.startsWith('POSTHOG_PERSONAL_API_KEY') ? 2 : 1);
  }
}
const data = Object.fromEntries(Object.keys(QUERIES).filter((name) => raw[name]).map((name) => [name, rowsOf(raw[name])]));
for (const name of Object.keys(QUERIES)) if (!data[name]) fail(`no results for ${name}`);

// ---------- other sources ----------
// Each needs its own access and is optional: a failure is shown in the report instead of stopping it.
// Saved results (--data) may carry them under the keys dashboard, metrika, database and langfuse.
const extra = {
  dashboard: raw.dashboard ?? null, metrika: raw.metrika ?? null, database: raw.database ?? null, langfuse: raw.langfuse ?? null,
};
const sourceErrors = {};
if (!extra.dashboard && dashboardConfigured()) {
  try {
    extra.dashboard = await collectDashboard({ from: fromDate, to: lastDate });
  } catch (error) {
    sourceErrors.dashboard = error.message;
  }
}
if (!extra.metrika && metrikaConfigured()) {
  try {
    extra.metrika = await collectMetrika({ from: fromDate, to: lastDate });
  } catch (error) {
    sourceErrors.metrika = error.message;
  }
}
let excluded = null;
if (databaseConfigured() && (!extra.database || !extra.langfuse)) {
  try {
    excluded = testAccountIds();
  } catch (error) {
    sourceErrors.database = error.message;
  }
}
if (!extra.database && excluded) {
  try {
    extra.database = collectDatabase({ from: values.from, to: values.to, excluded });
  } catch (error) {
    sourceErrors.database = error.message;
  }
}
if (!extra.langfuse && langfuseConfigured()) {
  try {
    extra.langfuse = collectLangfuse({ from: values.from, to: values.to, excluded });
  } catch (error) {
    sourceErrors.langfuse = error.message;
  }
}

// ---------- numbers ----------
const num = (v) => Number(v) || 0;
const share = (a, b) => (b > 0 ? (a / b) * 100 : NaN);
const median = (xs) => {
  const s = xs.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ru = (x, digits = 1) =>
  Number.isFinite(x) ? x.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: 0 }) : '—';
const ru1 = (x) => (Number.isFinite(x) ? x.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '—');
const int = (x) => num(x).toLocaleString('ru-RU');
// «у 31 человека», «у 5 человек».
const people = (n) => `${int(n)} ${n % 10 === 1 && n % 100 !== 11 ? 'человека' : 'человек'}`;
const pct = (x) => (Number.isFinite(x) ? `${ru(x)} %` : '—');

const FIELDS = ['visitors', 'landing', 'product', 'account', 'consents', 'dialog', 'spoke', 'd3', 'returned', 'turns'];
const sumRows = (rows) => {
  const total = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  total.first_dialogs = [];
  for (const r of rows) {
    for (const f of FIELDS) total[f] += num(r[f]);
    total.first_dialogs.push(...(r.first_dialogs ?? []));
  }
  return total;
};

// Channels: first touch by UTM source and campaign.
const channelOf = (source, campaign) => {
  if (source === '?') return { key: '?', label: 'Канал неизвестен', kind: 'unknown' };
  if (!source) return { key: '', label: 'Без метки', kind: 'row' };
  const s = source.toLowerCase();
  const name = s === 'yandex' || s === 'ya' ? 'Яндекс Директ' : s === 'tgads' ? 'Telegram Ads' : source;
  return { key: `${name}|${campaign}`, label: campaign ? `${name} · ${campaign}` : name, kind: 'row' };
};
const groups = new Map();
for (const r of data.cohort) {
  const ch = channelOf(r.utm_source ?? '', r.utm_campaign ?? '');
  if (!groups.has(ch.key)) groups.set(ch.key, { ...ch, rows: [] });
  groups.get(ch.key).rows.push(r);
}
const channelRow = (g) => {
  const t = sumRows(g.rows);
  return {
    label: g.label, kind: g.kind, visitors: t.visitors, product: t.product, account: t.account,
    spoke: t.spoke, d3: t.d3, returned: t.returned, conv: share(t.spoke, t.visitors),
    turnsPerSpeaker: t.spoke ? t.turns / t.spoke : null,
  };
};
let known = [...groups.values()].filter((g) => g.kind !== 'unknown').sort((a, b) => sumRows(b.rows).visitors - sumRows(a.rows).visitors);
const MAX_CHANNELS = 8;
if (known.length > MAX_CHANNELS) {
  const rest = known.slice(MAX_CHANNELS - 1);
  known = [...known.slice(0, MAX_CHANNELS - 1), { label: 'Прочие', kind: 'row', rows: rest.flatMap((g) => g.rows) }];
}
const unknown = [...groups.values()].filter((g) => g.kind === 'unknown');
const cohortTotal = sumRows(data.cohort);
const channels = [
  ...known.map(channelRow),
  ...unknown.map(channelRow),
  channelRow({ label: 'Всего', kind: 'total', rows: data.cohort }),
];

// Funnel with the device split.
const byDevice = (name) => sumRows(data.cohort.filter((r) => r.device === name));
const mobile = byDevice('Mobile');
const desktop = byDevice('Desktop');
const STEPS = [
  ['visitors', 'Посетители'], ['landing', 'Видели лендинг'], ['product', 'Пришли в продукт'], ['account', 'Аккаунт'],
  ['consents', 'Согласия'], ['dialog', 'Начали разговор'], ['spoke', 'Сказали реплику'], ['d3', 'Разговор от 3 реплик'],
  ['returned', 'Вернулись в другой день'],
];
const funnel = STEPS.map(([key, label]) => ({ key, label, total: cohortTotal[key], mobile: mobile[key], desktop: desktop[key] }));

// Days of the period.
const dayList = Array.from({ length: days }, (_, i) => shiftDate(fromDate, i));
const dailyBy = new Map(data.daily.map((r) => [r.day, r]));
const newBy = new Map(data.newSpeakers.map((r) => [r.day, r]));
const cohortBy = new Map(data.cohortDaily.map((r) => [r.day, r]));
const micBy = new Map(data.micDaily.map((r) => [r.day, num(r.people)]));
const dash = extra.dashboard;
const daily = dayList.map((d) => {
  const nb = newBy.get(d);
  return {
    date: d, day: ddmm(d), dau: num(dailyBy.get(d)?.dau), new: num(nb?.new_speakers), turns: num(dailyBy.get(d)?.turns),
    voice: num(dailyBy.get(d)?.voice),
    newD3: num(nb?.new_d3), returnedNew: num(nb?.returned), firstDialogs: (nb?.first_dialogs ?? []).map(num),
    visitors: num(cohortBy.get(d)?.visitors), cohortSpoke: num(cohortBy.get(d)?.spoke), micDenied: micBy.get(d) ?? 0,
    // The team's figures from the dashboard: null for a day it does not have (before the contest) or without access.
    sber: dash?.days?.[d] ?? null,
    // Filled from Langfuse and the database below; null when they are not available.
    traces: null, tokens: null, tokensPerDialog: null, dbUserMessages: null,
  };
});
const peak = daily.reduce((best, d) => (d.dau > best.dau ? d : best), daily[0]);
const yesterday = daily[daily.length - 1];

const sp = data.speakers[0] ?? {};
const speakers = num(sp.speakers);
const micDenied = num(data.quality.find((r) => r.kind === 'voice:permission_denied')?.people);
const landingToProduct = share(cohortTotal.product, cohortTotal.landing);

// What goes with coming back.
const ret = data.retention.map((r) => ({ ...r, people: num(r.people), returned: num(r.returned), memory: num(r.memory) === 1 || r.memory === true, wellbeing: num(r.wellbeing) === 1 || r.wellbeing === true }));
const sumBy = (pred) => ret.filter(pred).reduce((a, r) => ({ people: a.people + r.people, returned: a.returned + r.returned }), { people: 0, returned: 0 });
const returnBase = { label: 'заговорили с 14.10 и не позже суток до конца периода', ...sumBy(() => true) };
const returnRows = [
  ['Первый разговор: 1–2 реплики', (r) => r.first_dialog === 'fd1'],
  ['Первый разговор: 3–7', (r) => r.first_dialog === 'fd3'],
  ['Первый разговор: 8–14', (r) => r.first_dialog === 'fd8'],
  ['Первый разговор: 15–29', (r) => r.first_dialog === 'fd15'],
  ['Первый разговор: 30+', (r) => r.first_dialog === 'fd30'],
  ['Только текст', (r) => r.input === 'text'],
  ['Только голос', (r) => r.input === 'voice'],
  ['И голос, и текст', (r) => r.input === 'mixed'],
  ['Трогали память', (r) => r.memory],
  ['Дневник или тесты', (r) => r.wellbeing],
].map(([label, pred]) => ({ label, ...sumBy(pred) }));

const newSpeakers = daily.reduce((a, d) => a + d.new, 0);
const newD3 = data.newSpeakers.reduce((a, r) => a + num(r.new_d3), 0);
const dauAvg = daily.reduce((a, d) => a + d.dau, 0) / days;
const wau = data.wau[0] ?? {};
const medians = {
  all: median(cohortTotal.first_dialogs),
  mobile: median(mobile.first_dialogs),
  desktop: median(desktop.first_dialogs),
};

// Reconciliation: the team's figures from the dashboard, then Metrika's goals. The field `metrika` of a row is the
// value of the second source, whichever it is (`source`).
const reconcile = [];
const reconcileNotes = [];
const dashDays = daily.filter((d) => d.sber);
if (dashDays.length) {
  const sumOf = (rows, pick) => rows.reduce((a, d) => a + pick(d), 0);
  const span = dashDays.length === days ? '' : ` (${dashDays.length} из ${days} дней: остальных нет на дашборде)`;
  reconcile.push(
    { label: `DAU, сумма по дням${span}`, source: 'Дашборд', tip: 'PostHog — люди с репликой (dialog_turn) за сутки; дашборд — аккаунты с сообщением за сутки по базе агента и ходам из Langfuse. В PostHog нет отказавшихся от аналитики и разговоров «Не сохранять», поэтому он обычно меньше.', posthog: sumOf(dashDays, (d) => d.dau), metrika: sumOf(dashDays, (d) => d.sber.dau) },
    { label: `Новые${span}`, source: 'Дашборд', tip: 'PostHog — люди, чья первая реплика за всё время пришлась на эти дни (dialog_turn есть с 14.10.2026); дашборд — аккаунты, чьё первое известное сообщение пришлось на эти дни (счётчик реплик, база агента, Langfuse).', posthog: sumOf(dashDays, (d) => d.new), metrika: sumOf(dashDays, (d) => d.sber.new_users) },
  );
  reconcileNotes.push('С дашбордом PostHog обычно меньше: в нём нет отказавшихся от аналитики и разговоров «Не сохранять».');
}
const mk = extra.metrika;
if (mk) {
  const goalPeople = data.goalPeople[0] ?? {};
  const openAppDevices = num(data.openApp[0]?.devices);
  reconcile.push(
    { label: 'Посетители', source: 'Метрика', tip: 'PostHog — новые устройства периода; Метрика — уникальные посетители периода по своей cookie.', posthog: cohortTotal.visitors, metrika: mk.users },
    mk.goals.openApp && { label: 'Цель 1: открыли приложение', source: 'Метрика', tip: 'PostHog — устройства, нажавшие на лендинге «Открыть веб-приложение» или ссылку магазина; Метрика — цель 1 (open_app). Метрика теряет нажатия в первые 1–2 секунды после открытия лендинга, поэтому при рекламе в играх она заметно меньше.', posthog: openAppDevices, metrika: mk.goals.openApp.users },
    mk.goals.firstReply && { label: 'Цель 2: первая реплика', source: 'Метрика', tip: 'PostHog — люди, чья первая реплика за всё время пришлась на эти дни; Метрика — цель 2 (first_reply, первая реплика аккаунта).', posthog: newSpeakers, metrika: mk.goals.firstReply.users },
    mk.goals.polz3 && { label: 'Цель 3: 3+ реплики за сутки', source: 'Метрика', tip: 'Люди, у которых хотя бы в одни московские сутки периода было 3 реплики и больше; Метрика — цель 3 (polz_3).', posthog: num(goalPeople.polz3), metrika: mk.goals.polz3.users },
    mk.goals.dau10 && { label: 'Цель 4: 10+ реплик за сутки', source: 'Метрика', tip: 'Люди, у которых хотя бы в одни московские сутки периода было 10 реплик и больше; Метрика — цель 4 (dau_10).', posthog: num(goalPeople.dau10), metrika: mk.goals.dau10.users },
  );
  reconcileNotes.push('С Метрикой расхождение до 10 % — обычное: цели отправляет браузер (блокировщик, Do Not Track, закрытая вкладка), а посетителей она считает по своей cookie. Цель 1 при рекламе в играх меньше сильнее: быстрые нажатия не успевают дойти.');
}
// Yandex Direct through Metrika (spend needs access to the advertiser's Direct client): by campaign and by day.
const direct = mk?.direct && !mk.direct.error ? mk.direct : null;
if (mk?.direct?.error) sourceErrors.direct = mk.direct.error;
for (const d of daily) d.directCost = direct ? (direct.byDay[d.date]?.cost ?? 0) : null;
const perGoal = (cost, count) => (count > 0 && cost > 0 ? cost / count : null);
const directCampaigns = direct
  ? direct.campaigns.map((c) => ({
      ...c,
      perClick: perGoal(c.cost, c.clicks),
      perFirstReply: perGoal(c.cost, c.goals.firstReply ?? 0),
      perPolz3: perGoal(c.cost, c.goals.polz3 ?? 0),
    }))
  : [];
const directTotal = direct
  ? {
      clicks: direct.clicks, cost: direct.cost, visits: direct.visits, goals: direct.goals,
      perClick: perGoal(direct.cost, direct.clicks),
      perFirstReply: perGoal(direct.cost, direct.goals.firstReply ?? 0),
      perPolz3: perGoal(direct.cost, direct.goals.polz3 ?? 0),
    }
  : null;
const audience = mk && (mk.gender.length || mk.age.length)
  ? [
      ...(mk.gender.length ? [{ group: 'Пол' }, ...mk.gender] : []),
      ...(mk.age.length ? [{ group: 'Возраст' }, ...mk.age] : []),
    ]
  : [];
if (!mk) reconcileNotes.push(sourceErrors.metrika ? `Метрика: ${sourceErrors.metrika.replace(/^Metrika:?\s*/, '')}.` : 'Сверка с Метрикой появится, когда у агента будет к ней доступ.');
if (!dash) reconcileNotes.push(sourceErrors.dashboard ? `Дашборд: ${sourceErrors.dashboard.replace(/^dashboard:?\s*/, '')}.` : 'Сверка с дашбордом появится, когда у агента будет к нему доступ.');

// The database: true totals, token use and the state of features.
const db = extra.database;
const act = db?.activity;
const accountsPosthog = num(data.accounts[0]?.accounts);
if (db) {
  reconcile.push(
    { label: 'Говорили', source: 'База', tip: 'PostHog — люди с репликой в эти дни; база — авторы сообщений человека за те же дни. В PostHog нет тех, кто отказался от аналитики.', posthog: speakers, metrika: act.speakers },
    { label: 'Реплики', source: 'База', tip: 'PostHog — события dialog_turn; база — сообщения человека за те же дни. В базе меньше, если люди стёрли разговоры; в PostHog меньше, если кто-то отказался от аналитики.', posthog: num(sp.turns), metrika: act.user_messages },
    { label: 'Разговоры с репликой', source: 'База', tip: 'Разговоры, в которых человек сказал хоть что-то в эти дни.', posthog: num(sp.dialogs), metrika: act.dialogs },
    { label: 'Новые аккаунты', source: 'База', tip: 'PostHog — события account_created; база — аккаунты, созданные в эти дни (без тестовых и командных).', posthog: accountsPosthog, metrika: db.app.accounts_new },
  );
  reconcileNotes.push('С базой: PostHog не видит отказавшихся от аналитики, а в базе нет стёртых разговоров и сообщений 11–16.11.2026.');
}
const reconcileNote = reconcileNotes.join(' ');
const activeDays = act?.person_days || daily.reduce((a, d) => a + d.dau, 0);
// All model calls come from Langfuse (it also sees the conversations people asked not to save, so only the sum is
// shown); per conversation and per active day come from the database, which keeps saved conversations only.
const lf = extra.langfuse;
if (lf?.tracesByDay) for (const d of daily) d.traces = lf.tracesByDay[d.date] ?? 0;
for (const d of daily) {
  const dbDay = db?.daily?.[d.date];
  if (lf?.tokensByDay) d.tokens = lf.tokensByDay[d.date] ?? 0;
  else if (db?.daily) d.tokens = dbDay?.tokens ?? 0;
  if (db?.daily) {
    d.tokensPerDialog = dbDay?.dialogs ? dbDay.tokens / dbDay.dialogs : null;
    d.dbUserMessages = dbDay?.userMessages ?? 0;
  }
}
const dbUsage = db && db.usage.models.length ? db.usage : null;
const perConversation = dbUsage
  ? {
      dbTotal: dbUsage.total, dialogs: dbUsage.dialogs,
      perDialog: dbUsage.dialogs ? dbUsage.total / dbUsage.dialogs : null,
      perActiveDay: activeDays ? dbUsage.total / activeDays : null,
    }
  : { dbTotal: null, dialogs: null, perDialog: null, perActiveDay: null };
const models = lf && lf.rows.length
  ? { source: 'langfuse', rows: lf.rows, total: lf.total, withTests: !lf.testsExcluded, days, ...perConversation }
  : dbUsage
    ? { source: 'database', rows: dbUsage.models, total: dbUsage.total, withTests: false, days, ...perConversation }
    : null;
const features = db
  ? [
      { label: 'Память включена', value: db.memoryOn, note: 'людей сейчас', tip: 'Люди, у которых «Запоминать» включено (настройки памяти агента).' },
      { label: 'Отмечали настроение', value: db.app.mood_people, note: `людей, ${int(db.app.mood_checkins)} отметок`, tip: 'Люди с отметкой в дневнике настроения за эти дни.' },
      { label: 'Сохраняли тесты', value: db.app.tests_people, note: 'людей', tip: 'Люди, у которых в эти дни сохранился результат теста.' },
      { label: 'Подписаны на пуши', value: db.app.push_people, note: 'людей сейчас', tip: 'Люди с подпиской на уведомления (RuStore).' },
      { label: 'Новые аккаунты', value: db.app.accounts_new, note: `почта ${int(db.app.accounts_new_email)}, Telegram ${int(db.app.accounts_new_telegram)}, анонимные ${int(db.app.accounts_new_anonymous)}`, tip: 'Аккаунты, созданные в эти дни, по способу входа.' },
      { label: 'Отказались от аналитики', value: db.app.optout_total, note: `из ${int(db.app.accounts_total)} аккаунтов; новых в эти дни — ${int(db.app.optout_new)}`, tip: 'Переключатель «Помогать улучшать Рядом» выключен: такие люди не видны в PostHog.' },
      { label: 'Голос, минут речи людей', value: Math.round(act.user_audio_seconds / 60), note: `агента — ${int(Math.round(act.agent_audio_seconds / 60))}`, tip: 'Сумма длительности голосовых сообщений за эти дни.' },
    ]
  : [];

// The team's figures for the period: DAU and active accounts are per day and do not add up, new users and calls do.
const sberSum = (field) => dashDays.reduce((a, d) => a + d.sber[field], 0);
const sber = dashDays.length
  ? {
      days: dashDays.length, updatedAt: dash.updatedAt,
      dauAvg: sberSum('dau') / dashDays.length,
      dauPeak: dashDays.reduce((best, d) => (d.sber.dau > best.dau ? { day: d.day, dau: d.sber.dau } : best), { day: null, dau: -1 }),
      newUsers: sberSum('new_users'),
      totalUsers: dashDays[dashDays.length - 1].sber.total_users,
      totalUsersBefore: dashDays[0].sber.total_users - dashDays[0].sber.new_users,
      llmRequests: sberSum('llm_requests'), toolRequests: sberSum('tool_requests'),
    }
  : null;

const report = {
  period: { from: fromDate, to: lastDate, days, label: periodLabel, generatedAt: new Date().toISOString() },
  sources: { posthog: true, dashboard: Boolean(dash), metrika: Boolean(mk), direct: Boolean(direct), database: Boolean(db), langfuse: Boolean(lf) },
  sourceErrors,
  sber,
  direct: directTotal ? { ...directTotal, campaigns: directCampaigns } : null,
  metrika: mk,
  reconcile,
  audience,
  models,
  features,
  database: db,
  kpi: {
    newSpeakers, newD3, newYesterday: yesterday.new,
    cohortVisitors: cohortTotal.visitors, cohortSpoke: cohortTotal.spoke, conversion: share(cohortTotal.spoke, cohortTotal.visitors),
    dauAvg, dauYesterday: yesterday.dau, dauPeak: { day: peak.day, dau: peak.dau }, wau: num(wau.wau), wauPrev: num(wau.wau_prev),
    medianFirstDialog: medians,
    cohortReturned: cohortTotal.returned,
    speakers, dialogs: num(sp.dialogs), accounts: accountsPosthog,
    usedVoice: num(sp.used_voice), voiceShare: share(num(sp.used_voice), speakers),
    turns: num(sp.turns), voiceTurns: num(sp.voice_turns), textTurnShare: share(num(sp.turns) - num(sp.voice_turns), num(sp.turns)),
    micDeniedPeople: micDenied, landingToProduct,
    // By the day of the first reply: the same people as «Заговорили впервые».
    returnedNew: daily.reduce((a, d) => a + d.returnedNew, 0),
    firstDialogMedianNew: median(daily.flatMap((d) => d.firstDialogs)),
  },
  daily, channels, funnel, returnBase, returnRows,
  reconcileNote,
};

// ---------- issue description (Markdown) ----------
const k = report.kpi;
const sourceMark = (ok, error) => (ok ? '✅' : error ? '⚠️' : '❌');
const sourcesLine = `Источники: PostHog ✅ · дашборд ${sourceMark(dash, sourceErrors.dashboard)} · Метрика ${sourceMark(mk, sourceErrors.metrika)} · Директ ${sourceMark(direct, sourceErrors.direct)} · база ${sourceMark(db, sourceErrors.database)} · Langfuse ${sourceMark(lf, sourceErrors.langfuse)}`;
const SOURCE_NAMES = { dashboard: 'Дашборд', metrika: 'Метрика', direct: 'Директ', database: 'База', langfuse: 'Langfuse' };
const errorLine = Object.entries(sourceErrors)
  .map(([name, message]) => `${SOURCE_NAMES[name]}: ${message.replace(/^(dashboard|Metrika|база|Langfuse):?\s*/i, '').replace(/\|/g, '/')}`)
  .join('. ');

// The first table: every figure by Moscow day and for the whole period. People are counted once in the period column,
// events and tokens add up, shares are taken over the whole period.
const mln = (x) => (x / 1e6).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const medianCell = (xs) => {
  const m = median(xs);
  return m == null || !Number.isFinite(m) ? '—' : ru(m);
};
const mainRows = [
  ['Новые устройства', daily.map((d) => int(d.visitors)), int(cohortTotal.visitors)],
  ['Посетитель → заговорил', daily.map((d) => pct(share(d.cohortSpoke, d.visitors))), pct(k.conversion)],
  ['Заговорили впервые', daily.map((d) => int(d.new)), int(newSpeakers)],
  ['из них разговор от 3 реплик', daily.map((d) => int(d.newD3)), int(newD3)],
  ['Первый разговор, медиана реплик', daily.map((d) => medianCell(d.firstDialogs)), medianCell(daily.flatMap((d) => d.firstDialogs))],
  ['Вернулись в другой день', daily.map((d) => int(d.returnedNew)), int(k.returnedNew)],
  ['Говорили по PostHog (DAU, за период — WAU)', daily.map((d) => int(d.dau)), int(k.wau)],
  ['Реплики', daily.map((d) => int(d.turns)), int(sp.turns)],
  ['Говорили голосом', daily.map((d) => pct(share(d.voice, d.dau))), pct(k.voiceShare)],
  ['Отказ в микрофоне, людей', daily.map((d) => int(d.micDenied)), int(micDenied)],
  direct ? ['Расход Директа, ₽', daily.map((d) => int(Math.round(d.directCost))), int(Math.round(direct.cost))] : null,
  db?.app.optout_total
    ? ['Видно в PostHog', daily.map((d) => pct(share(d.turns, d.dbUserMessages))), pct(share(num(sp.turns), act.user_messages))]
    : null,
  models
    ? [`Расход моделей, млн токенов${models.withTests ? ' (с тестовыми)' : ''}`, daily.map((d) => (d.tokens == null ? '—' : mln(d.tokens))), mln(models.total)]
    : null,
  models?.perDialog != null
    ? ['Токенов на разговор', daily.map((d) => (d.tokensPerDialog == null ? '—' : int(Math.round(d.tokensPerDialog)))), int(Math.round(models.perDialog))]
    : null,
].filter(Boolean);
const mainTable = [
  `| Показатель | ${daily.map((d) => d.day).join(' | ')} | За ${days} дней |`,
  `|---|${daily.map(() => '---:').join('|')}|---:|`,
  ...mainRows.map(([label, cells, total]) => `| ${label} | ${cells.join(' | ')} | **${total}** |`),
].join('\n');

// Plain digits: the by-day table is meant to be pasted into a spreadsheet, where grouped digits become text.
const plain = (x) => String(Math.round(num(x)));
const SBER_COLUMNS = [
  ['dau', 'DAU'], ['new_users', 'Новые пользователи'], ['total_users', 'Пользователи всего'],
  ['daily_active_account', 'Активные: больше 10 сообщений'], ['llm_requests', 'Вызовы LLM'], ['tool_requests', 'Tool calls — Память'],
];
const sberTable = dash
  ? [
      `| Дата | ${SBER_COLUMNS.map(([, label]) => label).join(' | ')} |`,
      `|---|${SBER_COLUMNS.map(() => '---:').join('|')}|`,
      ...daily.map((d) => `| ${d.day} | ${SBER_COLUMNS.map(([field]) => (d.sber ? plain(d.sber[field]) : '—')).join(' | ')} |`),
    ].join('\n')
  : `Дашборд ${sourceErrors.dashboard ? 'не ответил' : 'недоступен агенту'}: таблицы нет.`;
const rub = (x) => (x == null ? '—' : int(Math.round(x)));
const directTable = directTotal
  ? [
      '| Кампания | Расход, ₽ | Клики | ₽ за клик | Первая реплика (цель 2) | ₽ за первую реплику | 3+ реплики за сутки (цель 3) | ₽ за цель 3 |',
      '|---|---:|---:|---:|---:|---:|---:|---:|',
      ...directCampaigns.map((c) => `| ${c.name.replace(/\|/g, '/')} | ${rub(c.cost)} | ${int(c.clicks)} | ${rub(c.perClick)} | ${int(c.goals.firstReply ?? 0)} | ${rub(c.perFirstReply)} | ${int(c.goals.polz3 ?? 0)} | ${rub(c.perPolz3)} |`),
      `| **Всего** | **${rub(directTotal.cost)}** | **${int(directTotal.clicks)}** | **${rub(directTotal.perClick)}** | **${int(directTotal.goals.firstReply ?? 0)}** | **${rub(directTotal.perFirstReply)}** | **${int(directTotal.goals.polz3 ?? 0)}** | **${rub(directTotal.perPolz3)}** |`,
    ].join('\n')
  : null;
const title = `Сводка Рядом · ${periodLabel}`;
const description = `Автоматический отчёт за ${days} полных дней по Москве (${periodLabel}). Детализация с графиком и таблицами — в первом комментарии. Прочитали — закройте задачу.

${sourcesLine}${errorLine ? `\n${errorLine}.` : ''}

${mainTable}

### Главное

<!-- ГЛАВНОЕ -->

### По дням — как на дашборде Sber500

${sberTable}
${directTable ? `\n### Реклама в Директе\n\n${directTable}\n` : ''}
### Как считаются цифры

- **По дням — как на дашборде Sber500.** Числа взяты из дашборда (\`/dashboard/api\`) как есть: это определения команды, прошедшие сутки там закрыты снимком и не пересчитываются. Сообщения — база агента и ходы разговора из Langfuse вместе (в базе нет сообщений 11–16.11.2026), без тестовых и командных аккаунтов. **DAU** — аккаунты хотя бы с одним сообщением за сутки. **Новые пользователи** — аккаунты, чьё первое известное сообщение пришлось на эти сутки. **Пользователи всего** — накопленный итог новых с 05.11.2026, удалённые не вычитаются. **Активные** — больше 10 сообщений за сутки (внутренняя метрика). **Вызовы LLM** — вызовы моделей от действий людей (ответ, итог разговора, память, настроение) без повторов, прогревов, озвучки и плановых сводок. **Tool calls — Память** — успешные обращения агента к памяти. Дней до 05.11.2026 на дашборде нет («—»).
- **Главная таблица — PostHog.** День — московские сутки. В колонке «За ${days} дней» люди считаются один раз (поэтому DAU за период — это WAU), реплики, отказы и токены складываются, доли считаются по всему периоду. PostHog нужен для долей и разрезов: каналы, голос, возврат.
- **Новые** — люди и устройства, впервые появившиеся в эти дни; учитываются только настоящие люди (без тестов и команды).
- **Посетитель** — устройство: до входа события анонимны. **Посетитель → заговорил** — заговорившие ÷ новые устройства, по дню первого появления устройства.
- **Заговорил** — сервер принял хотя бы одну реплику (\`dialog_turn\`), набранную или сказанную.
- **Говорили по PostHog (DAU)** — люди с репликой за московские сутки; **WAU** — люди с репликой за весь период. Обычно немного меньше DAU дашборда: в PostHog нет отказавшихся от аналитики и разговоров «Не сохранять».
- **Разговор от 3 реплик** — три реплики под одним \`dialog_id\`; реплики разных разговоров не складываются.
- **Первый разговор** — число реплик в самом раннем разговоре человека; **Вернулись в другой день** — из заговоривших впервые, у кого есть реплики ещё в каком-то дне до конца периода. Обе строки — по дню первой реплики; число вернувшихся за последние дни ещё вырастет.
- **Говорили голосом** — хотя бы одна голосовая реплика: за день — доля от DAU, за период — от WAU.
- **Канал** — UTM первой сессии с просмотром страницы.
- **Метрика** — счётчик «Слышу Рядом»: посетители и цели 1–4 за те же дни (сверка в детализации), пол и возраст по данным Яндекса.
- **Реклама в Директе** — по Метрике: расход и клики кампаний Директа, визиты и цели по кампании последнего значимого перехода. Цель — люди (посетители), достигшие её за период. **₽ за первую реплику** и **₽ за цель 3** — расход кампании ÷ число таких людей; оба числа из Метрики. Цель 2 срабатывает раз на аккаунт, поэтому «₽ за первую реплику» — цена нового заговорившего. Расход Telegram Ads сюда не входит. **Расход Директа, ₽** в главной таблице — по дням.
- **База** — боевые базы приложения и агента, только чтение и только суммы. **Видно в PostHog** (появляется, если кто-то отказался от аналитики) — реплики в PostHog ÷ сообщения человека в базе.
- **Расход моделей** — токены всех вызовов моделей агента за те же дни по Langfuse, без тестовых и командных аккаунтов; в него входят и разговоры «Не сохранять», и стёртые — только суммой. Вызовы через прокси (итог разговора, память) и озвучка фраз приходят без токенов, так что настоящий расход немного больше.
- **Токенов на разговор** — расход в сохраняемых разговорах из базы агента ÷ разговоры с расходом в тот же день (за период — ÷ разговоры с расходом за период).
`;

// ---------- detail (inline html block) ----------
const template = readFileSync(join(here, 'report-detail.html'), 'utf8');
// Neither </script> nor a Markdown fence may appear inside the block.
const json = JSON.stringify(report).replace(/</g, '\\u003c').replace(/`/g, '\\u0060');
const detail = template.replace('/*__DATA__*/null', json);
if (detail === template) fail('report-detail.html: the /*__DATA__*/null placeholder is missing');
if (detail.includes('```')) fail('detail.html contains a Markdown fence');

const detailComment = `Детализация к сводке за ${periodLabel}: по дням, каналы, воронка, что связано с возвратом, сверка источников. У подчёркнутых заголовков колонок — подсказка, что это и как считается.

\`\`\`html title="Сводка Рядом, детализация ${periodLabel}"
${detail.trim()}
\`\`\`
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1));
writeFileSync(join(outDir, 'detail.html'), detail);
writeFileSync(join(outDir, 'title.txt'), title);
writeFileSync(join(outDir, 'description.md'), description);
writeFileSync(join(outDir, 'detail-comment.md'), detailComment);
console.log(`period ${periodLabel} (${values.from} … ${values.to} UTC)`);
console.log(`wrote ${outDir}: title.txt, description.md, detail-comment.md, detail.html, report.json`);
console.log('next: replace the <!-- ГЛАВНОЕ --> line of description.md with 3–5 numbered points read from report.json');
