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
import { collectDatabase, databaseConfigured } from './database.mjs';
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

  // DAU and replies per Moscow day.
  daily: `
SELECT toString(day) AS day, dau, turns FROM (
  SELECT toDate(toTimeZone(timestamp, 'Europe/Moscow')) AS day, uniq(person_id) AS dau, count() AS turns
  FROM events WHERE event = 'dialog_turn' AND {{people}} AND ${WINDOW}
  GROUP BY day)
ORDER BY day
LIMIT 100`,

  // People whose first reply ever fell on each day, and how many of them had a dialog of 3+ replies.
  newSpeakers: `
SELECT toString(toDate(toTimeZone(ft, 'Europe/Moscow'))) AS day, count() AS new_speakers, countIf(best >= 3) AS new_d3
FROM (SELECT person_id, min(t0) AS ft, max(r) AS best FROM (${DIALOGS}) GROUP BY person_id)
WHERE ft >= toDateTime('{{from}}')
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
// Saved results (--data) may carry them under the keys metrika and database.
const extra = { metrika: raw.metrika ?? null, database: raw.database ?? null };
const sourceErrors = {};
if (!extra.metrika && metrikaConfigured()) {
  try {
    extra.metrika = await collectMetrika({ from: fromDate, to: lastDate });
  } catch (error) {
    sourceErrors.metrika = error.message;
  }
}
if (!extra.database && databaseConfigured()) {
  try {
    extra.database = collectDatabase({ from: values.from, to: values.to });
  } catch (error) {
    sourceErrors.database = error.message;
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
const daily = dayList.map((d) => ({ date: d, day: ddmm(d), dau: num(dailyBy.get(d)?.dau), new: num(newBy.get(d)?.new_speakers), turns: num(dailyBy.get(d)?.turns) }));
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

// Reconciliation and audience from Metrika.
const mk = extra.metrika;
const reconcile = mk
  ? [
      { label: 'Посетители', source: 'Метрика', tip: 'PostHog — новые устройства периода; Метрика — уникальные посетители периода по своей cookie.', posthog: cohortTotal.visitors, metrika: mk.users },
      mk.goals.product && { label: 'Пришли в продукт', source: 'Метрика', tip: 'Метрика: цель «Переход в продукт» (адрес содержит /app/ или /pwa/; Android и iOS не входят).', posthog: cohortTotal.product, metrika: mk.goals.product.users },
      mk.goals.reply && { label: 'Сказали реплику', source: 'Метрика', tip: 'Метрика: цель first_reply, уникальные посетители.', posthog: cohortTotal.spoke, metrika: mk.goals.reply.users },
      mk.goals.d3 && { label: 'Разговор от 3 реплик', source: 'Метрика', tip: 'Метрика: цель first_dialog_3_replies, один раз на устройстве.', posthog: cohortTotal.d3, metrika: mk.goals.d3.users },
    ].filter(Boolean)
  : [];
const audience = mk && (mk.gender.length || mk.age.length)
  ? [
      ...(mk.gender.length ? [{ group: 'Пол' }, ...mk.gender] : []),
      ...(mk.age.length ? [{ group: 'Возраст' }, ...mk.age] : []),
    ]
  : [];
let reconcileNote = mk
  ? 'Расхождение до 10 % — обычное: PostHog считает новые устройства, Метрика — посетителей по своей cookie.'
  : 'Сверка с Метрикой появится, когда у агента будет к ней доступ.';
if (sourceErrors.metrika) reconcileNote = `Метрика: ${sourceErrors.metrika.replace(/^Metrika:?\s*/, '')}`;

// The database: true totals, token use and the state of features.
const db = extra.database;
const act = db?.activity;
const accountsPosthog = num(data.accounts[0]?.accounts);
if (db) {
  reconcile.push(
    { label: 'Говорили', source: 'База', tip: 'PostHog — люди с репликой в эти дни; база — авторы сообщений человека за те же дни. В PostHog нет тех, кто отказался от аналитики.', posthog: speakers, metrika: act.speakers },
    { label: 'Реплики', source: 'База', tip: 'PostHog — события dialog_turn; база — сообщения человека за те же дни.', posthog: num(sp.turns), metrika: act.user_messages },
    { label: 'Разговоры с репликой', source: 'База', tip: 'Разговоры, в которых человек сказал хоть что-то в эти дни.', posthog: num(sp.dialogs), metrika: act.dialogs },
    { label: 'Новые аккаунты', source: 'База', tip: 'PostHog — события account_created; база — аккаунты, созданные в эти дни (без тестовых и командных).', posthog: accountsPosthog, metrika: db.app.accounts_new },
  );
  if (!mk) reconcileNote = 'PostHog не видит тех, кто отказался от аналитики, поэтому в базе людей и реплик обычно больше.';
}
const activeDays = act?.person_days || daily.reduce((a, d) => a + d.dau, 0);
const models = db && db.usage.models.length
  ? {
      rows: db.usage.models, total: db.usage.total, days, dialogs: db.usage.dialogs,
      perDialog: db.usage.dialogs ? db.usage.total / db.usage.dialogs : null,
      perActiveDay: activeDays ? db.usage.total / activeDays : null,
    }
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

const report = {
  period: { from: fromDate, to: lastDate, days, label: periodLabel, generatedAt: new Date().toISOString() },
  sources: { posthog: true, metrika: Boolean(mk), database: Boolean(db) },
  sourceErrors,
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
  },
  daily, channels, funnel, returnBase, returnRows,
  reconcileNote,
};

// ---------- issue description (Markdown) ----------
const k = report.kpi;
const dev = (label, v) => (v == null ? null : `${label} ${ru(v)}`);
const medianNote = [dev('телефон', medians.mobile), dev('компьютер', medians.desktop)].filter(Boolean).join(', ') || '—';
const sourceMark = (ok, error) => (ok ? '✅' : error ? '⚠️' : '❌');
const sourcesLine = `Источники: PostHog ✅ · Метрика ${sourceMark(mk, sourceErrors.metrika)} · база ${sourceMark(db, sourceErrors.database)}`;
const errorLine = Object.entries(sourceErrors)
  .map(([name, message]) => `${name === 'metrika' ? 'Метрика' : 'База'}: ${message.replace(/^(Metrika|база):?\s*/i, '').replace(/\|/g, '/')}`)
  .join('. ');
const millions = (x) => `${ru(x / 1e6)} млн`;
const topModel = models?.rows[0];
const dbRows = db
  ? [
      `| Видно в PostHog | **${pct(share(num(sp.turns), act.user_messages))}** | ${int(sp.turns)} из ${int(act.user_messages)} реплик; от аналитики отказались ${people(db.app.optout_total)} |`,
      models
        ? `| Токенов на разговор | **${int(Math.round(models.perDialog ?? 0))}** | на активного в день — ${int(Math.round(models.perActiveDay ?? 0))}; всего ${millions(models.total)} за ${days} дн.${topModel ? `; больше всего — ${topModel.model}${topModel.task ? ` · ${topModel.task}` : ''} (${pct(share(topModel.input + topModel.output, models.total))})` : ''} |`
        : null,
    ].filter(Boolean).join('\n') + '\n'
  : '';

const title = `Сводка Рядом · ${periodLabel}`;
const description = `Автоматический отчёт за ${days} полных дней по Москве (${periodLabel}). Детализация с графиком и таблицами — в первом комментарии. Прочитали — закройте задачу.

${sourcesLine}${errorLine ? `\n${errorLine}.` : ''}

| Показатель | Значение | Контекст |
|---|---:|---|
| Заговорили впервые | **${int(newSpeakers)}** | из них разговор от 3 реплик — ${int(newD3)}; вчера — ${int(yesterday.new)} |
| Посетитель → заговорил | **${pct(k.conversion)}** | ${int(k.cohortSpoke)} из ${int(k.cohortVisitors)} новых устройств |
| DAU в среднем | **${ru1(dauAvg)}** | вчера ${int(yesterday.dau)}, пик ${int(peak.dau)} (${peak.day}); WAU ${int(k.wau)}, неделей раньше ${int(k.wauPrev)} |
| Первый разговор, медиана | **${medians.all == null ? '—' : `${ru(medians.all)} реплик`}** | ${medianNote} |
| Вернулись в другой день | **${int(cohortTotal.returned)} из ${int(cohortTotal.spoke)}** | новые этих дней, число ещё вырастет |
| Говорили голосом | **${pct(k.voiceShare)}** | ${int(k.usedVoice)} из ${int(speakers)}; отказ в микрофоне у ${people(micDenied)} |
${dbRows}
### Главное

<!-- ГЛАВНОЕ -->

### Как считаются цифры

- **Новые** — люди и устройства, впервые появившиеся в эти дни; учитываются только настоящие люди (без тестов и команды).
- **Посетитель** — устройство: до входа события анонимны. **Посетитель → заговорил** — заговорившие ÷ новые устройства.
- **Заговорил** — сервер принял хотя бы одну реплику (\`dialog_turn\`), набранную или сказанную.
- **DAU** — люди с репликой за московские сутки, среднее за дни периода; **WAU** — за все дни периода.
- **Разговор от 3 реплик** — три реплики под одним \`dialog_id\`; реплики разных разговоров не складываются.
- **Первый разговор** — число реплик в самом раннем разговоре человека.
- **Вернулся** — реплики в двух разных днях по Москве.
- **Говорили голосом** — хотя бы одна голосовая реплика.
- **Канал** — UTM первой сессии с просмотром страницы.
- **Метрика** — счётчик «Слышу Рядом»: посетители и цели за те же дни, пол и возраст по данным Яндекса.
- **База** — боевые базы приложения и агента, только чтение и только суммы. **Видно в PostHog** — реплики в PostHog ÷ сообщения человека в базе: PostHog не видит тех, кто отказался от аналитики.
- **Токены** — расход всех моделей агента за те же дни из его базы; на разговор — ÷ разговоры с расходом, на активного в день — ÷ дни, в которые человек говорил.
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
