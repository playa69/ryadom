#!/usr/bin/env node
// The «Сводка Рядом» report: a Markdown summary plus an inline ```html detail block for a Multica comment.
//   node report.mjs [--to YYYY-MM-DD] [--days 7] [--out DIR]   query PostHog and write DIR/{comment.md,detail.html,report.json}
//   node report.mjs --queries [--to …] [--days …]               print the filled queries as JSON (no key needed)
//   node report.mjs --data results.json [--to …] [--days …]     render from saved results {name: {columns, results}}
// The period is --days full Moscow days ending before --to (default: today in Moscow), so a 09:00 run covers the
// last week up to yesterday. Every number is computed here; the agent only replaces the <!-- ГЛАВНОЕ --> line of
// comment.md with its reading of report.json, so the figures never pass through a model.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
SELECT count() AS speakers, countIf(v > 0) AS used_voice, sum(t) AS turns, sum(v) AS voice_turns, countIf(le > 0) AS hit_live_error
FROM (
  SELECT person_id,
    countIf(event = 'dialog_turn') AS t,
    countIf(event = 'dialog_turn' AND properties.input = 'voice') AS v,
    countIf(event = 'component_called' AND properties.component = 'live' AND properties.outcome = 'error') AS le
  FROM events
  WHERE {{people}} AND event IN ('dialog_turn', 'component_called') AND ${WINDOW}
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
const data = Object.fromEntries(Object.entries(raw).map(([name, body]) => [name, rowsOf(body)]));
for (const name of Object.keys(QUERIES)) if (!data[name]) fail(`no results for ${name}`);

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
const liveShare = share(num(sp.hit_live_error), speakers);
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

const report = {
  period: { from: fromDate, to: lastDate, days, label: periodLabel, generatedAt: new Date().toISOString() },
  sources: { posthog: true, metrika: false, prometheus: false, database: false },
  kpi: {
    newSpeakers, newD3, newYesterday: yesterday.new,
    cohortVisitors: cohortTotal.visitors, cohortSpoke: cohortTotal.spoke, conversion: share(cohortTotal.spoke, cohortTotal.visitors),
    dauAvg, dauYesterday: yesterday.dau, dauPeak: { day: peak.day, dau: peak.dau }, wau: num(wau.wau), wauPrev: num(wau.wau_prev),
    medianFirstDialog: medians,
    cohortReturned: cohortTotal.returned,
    speakers, liveErrorPeople: num(sp.hit_live_error), liveErrorShare: liveShare,
    usedVoice: num(sp.used_voice), voiceShare: share(num(sp.used_voice), speakers),
    turns: num(sp.turns), voiceTurns: num(sp.voice_turns), textTurnShare: share(num(sp.turns) - num(sp.voice_turns), num(sp.turns)),
    micDeniedPeople: micDenied, landingToProduct,
  },
  daily, channels, funnel, returnBase, returnRows,
  reconcileNote: 'Сверка с Метрикой и базой появится, когда у агента будет к ним доступ: сейчас отчёт собран только из PostHog.',
};

// ---------- summary (Markdown) ----------
const titled = (title, text) => `<span title="${title.replace(/"/g, '&quot;')}">${text}</span>`;
const k = report.kpi;
const dev = (label, v) => (v == null ? null : `${label} ${ru(v)}`);
const medianNote = [dev('телефон', medians.mobile), dev('компьютер', medians.desktop)].filter(Boolean).join(', ') || '—';

const summary = `## Сводка Рядом · ${periodLabel}

${days} полных дней по Москве. Новые — люди и устройства, впервые появившиеся в эти дни. Фильтр настоящих людей из скилла \`analytics\`.
Источники: PostHog ✅ · Метрика ❌ · Prometheus ❌ · база ❌

| Показатель | Значение | Контекст |
|---|---:|---|
| ${titled('Первая реплика человека вообще (dialog_turn) пришлась на эти дни', 'Заговорили впервые')} | **${int(newSpeakers)}** | из них разговор от 3 реплик — ${int(newD3)}; вчера — ${int(yesterday.new)} |
| ${titled('Заговорившие ÷ устройства, впервые появившиеся в эти дни', 'Посетитель → заговорил')} | **${pct(k.conversion)}** | ${int(k.cohortSpoke)} из ${int(k.cohortVisitors)} новых устройств |
| ${titled('Людей с репликой за московские сутки, среднее за дни периода', 'DAU в среднем')} | **${ru1(dauAvg)}** | вчера ${int(yesterday.dau)}, пик ${int(peak.dau)} (${peak.day}); WAU ${int(k.wau)}, неделей раньше ${int(k.wauPrev)} |
| ${titled('Медиана числа реплик в самом раннем разговоре новых заговоривших', 'Первый разговор, медиана')} | **${medians.all == null ? '—' : `${ru(medians.all)} реплик`}** | ${medianNote} |
| ${titled('Новые заговорившие, у которых реплики минимум в двух разных днях по Москве', 'Вернулись в другой день')} | **${int(cohortTotal.returned)} из ${int(cohortTotal.spoke)}** | новые этих дней, число ещё вырастет |
| ${titled('Доля говоривших в эти дни, у которых был component_called live с outcome = error', 'Поймали ошибку live')} | **${pct(liveShare)}** | ${int(k.liveErrorPeople)} из ${int(speakers)} говоривших |
| ${titled('Хотя бы одна голосовая реплика (input = voice) среди говоривших в эти дни', 'Говорили голосом')} | **${pct(k.voiceShare)}** | ${int(k.usedVoice)} из ${int(speakers)}; отказ в микрофоне у ${people(micDenied)} |

### Главное

<!-- ГЛАВНОЕ -->

<details>
<summary>Как считаются цифры</summary>

- **Период** — ${days} полных дней по Москве, ${periodLabel}.
- **Посетитель** — устройство: до входа события анонимны.
- **Заговорил** — сервер принял хотя бы одну реплику (\`dialog_turn\`).
- **Разговор от 3 реплик** — три реплики под одним \`dialog_id\`; реплики разных разговоров не складываются.
- **Вернулся** — реплики в двух разных днях по Москве.
- **Канал** — UTM первой сессии с просмотром страницы.

</details>
`;

// ---------- detail (inline html block) ----------
const template = readFileSync(join(here, 'report-detail.html'), 'utf8');
// Neither </script> nor a Markdown fence may appear inside the block.
const json = JSON.stringify(report).replace(/</g, '\\u003c').replace(/`/g, '\\u0060');
const detail = template.replace('/*__DATA__*/null', json);
if (detail === template) fail('report-detail.html: the /*__DATA__*/null placeholder is missing');
if (detail.includes('```')) fail('detail.html contains a Markdown fence');

const comment = `${summary}
\`\`\`html title="Сводка Рядом, детализация ${periodLabel}"
${detail.trim()}
\`\`\`
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1));
writeFileSync(join(outDir, 'detail.html'), detail);
writeFileSync(join(outDir, 'comment.md'), comment);
console.log(`period ${periodLabel} (${values.from} … ${values.to} UTC)`);
console.log(`wrote ${join(outDir, 'comment.md')}, detail.html, report.json`);
console.log('next: replace the <!-- ГЛАВНОЕ --> line of comment.md with 3–5 numbered points read from report.json');
