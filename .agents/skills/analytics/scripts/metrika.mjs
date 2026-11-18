// Yandex Metrika (the counter «Слышу Рядом») through the Reports API: totals and goals for the reconciliation, and who
// comes (age, gender) with the share that reaches goal 3 (3+ replies in a day). Read-only.
// The OAuth token (scope metrika:read) comes from YANDEX_METRIKA_TOKEN; it is never printed.
// YANDEX_METRIKA_COUNTER overrides the counter.
const API = 'https://api-metrika.yandex.net';
const COUNTER = process.env.YANDEX_METRIKA_COUNTER || '114043323';
// The goals of the marketing brief (since 13.11.2026), found by their JS identifiers (MetrikaGoal in events.ts):
// goal 1 — a landing button into the product, goal 2 — the account's first reply, goals 3 and 4 — the account's
// third and tenth reply of a Moscow day. The former page goal «Переход в продукт» is archived and
// first_dialog_3_replies is deleted, so periods before 13.11 have no counterpart here.
const GOALS = { openApp: 'open_app', firstReply: 'first_reply', polz3: 'polz_3', dau10: 'dau_10' };

export const metrikaConfigured = () => Boolean(process.env.YANDEX_METRIKA_TOKEN);

async function get(path, params = {}) {
  const url = new URL(API + path);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetch(url, { headers: { Authorization: `OAuth ${process.env.YANDEX_METRIKA_TOKEN}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Metrika HTTP ${response.status}: ${String(body.message ?? '').slice(0, 200)}`);
  return body;
}

const goalBy = (goals, identifier) =>
  goals.find((g) => (g.conditions ?? []).some((c) => c.url === identifier || c.value === identifier));

// from and to are Moscow dates, both included (the counter keeps Moscow time).
export async function collectMetrika({ from, to }) {
  const { goals = [] } = await get(`/management/v1/counter/${COUNTER}/goals`);
  const goal = Object.fromEntries(Object.entries(GOALS).map(([key, identifier]) => [key, goalBy(goals, identifier)]));
  const found = Object.entries(goal).filter(([, g]) => g);
  const base = { ids: COUNTER, date1: from, date2: to, accuracy: 'full', lang: 'ru' };

  const metrics = ['ym:s:visits', 'ym:s:users', ...found.map(([, g]) => `ym:s:goal${g.id}users`)];
  const summary = await get('/stat/v1/data', { ...base, metrics: metrics.join(',') });
  const totals = summary.totals ?? [];
  const goalUsers = Object.fromEntries(found.map(([key], i) => [key, Number(totals[2 + i]) || 0]));

  const audience = async (dimension) => {
    if (!goal.polz3) return [];
    const body = await get('/stat/v1/data', {
      ...base,
      dimensions: dimension,
      metrics: `ym:s:users,ym:s:goal${goal.polz3.id}users`,
      limit: 20,
    });
    const rows = (body.data ?? []).map((row) => ({
      label: row.dimensions?.[0]?.name ?? '—',
      users: Number(row.metrics?.[0]) || 0,
      reached: Number(row.metrics?.[1]) || 0,
    }));
    // Age groups in their natural order: «младше 18» first, then by the first number in the name.
    const order = (label) => (/^(младше|younger)/i.test(label) ? -1 : Number(label.match(/\d+/)?.[0] ?? 999));
    return dimension === 'ym:s:ageInterval' ? rows.sort((a, b) => order(a.label) - order(b.label)) : rows;
  };

  return {
    counter: COUNTER,
    visits: Number(totals[0]) || 0,
    users: Number(totals[1]) || 0,
    goals: Object.fromEntries(found.map(([key, g]) => [key, { name: g.name, users: goalUsers[key] }])),
    missingGoals: Object.keys(goal).filter((key) => !goal[key]),
    age: await audience('ym:s:ageInterval'),
    gender: await audience('ym:s:gender'),
  };
}
