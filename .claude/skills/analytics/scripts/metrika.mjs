// Yandex Metrika (the counter «Слышу Рядом») through the Reports API: totals and goals for the reconciliation, and who
// comes (age, gender) with the share that reaches goal 3 (3+ replies in a day), and Yandex Direct spend by campaign.
// Read-only.
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

const GOAL_KEYS = Object.keys(GOALS);
const n = (v) => Number(v) || 0;

// Yandex Direct through Metrika: spend and clicks (the ym:ad namespace) need the token's login to have access to the
// advertiser's Direct client — a representative, read access is enough. The clients are found from the counter, so
// there is nothing to configure; without access this returns { error } and the rest of the report goes on.
// Visits and goals by campaign (ym:s) come from the same counter, joined to the spend by the campaign id: both
// figures of a «₽ per goal» are Metrika's. Only counts leave: no client logins.
async function collectDirect(base, goal) {
  const { clients = [] } = await get('/management/v1/clients', { counters: COUNTER });
  const logins = [...new Set(clients.map((c) => c.chief_login).filter(Boolean))];
  if (!logins.length) return { error: 'нет доступа к клиенту Директа: приглашение не выдано или не принято' };
  const ad = { ...base, direct_client_logins: logins.join(','), limit: 100 };
  const goalKeys = GOAL_KEYS.filter((key) => goal[key]);
  const [spend, spendByDay, visits] = await Promise.all([
    get('/stat/v1/data', { ...ad, dimensions: 'ym:ad:lastsignDirectOrder', metrics: 'ym:ad:clicks,ym:ad:RUBAdCost' }),
    get('/stat/v1/data', { ...ad, dimensions: 'ym:ad:date', metrics: 'ym:ad:clicks,ym:ad:RUBAdCost' }),
    get('/stat/v1/data', {
      ...base,
      limit: 100,
      dimensions: 'ym:s:lastsignDirectClickOrder',
      metrics: ['ym:s:visits', 'ym:s:users', ...goalKeys.map((key) => `ym:s:goal${goal[key].id}users`)].join(','),
    }),
  ]);
  const byId = new Map();
  const campaign = (dim) => {
    const key = String(dim?.id ?? dim?.name ?? '—');
    if (!byId.has(key)) byId.set(key, { name: dim?.name ?? '—', clicks: 0, cost: 0, visits: 0, users: 0, goals: {} });
    return byId.get(key);
  };
  for (const row of spend.data ?? []) {
    const c = campaign(row.dimensions?.[0]);
    c.clicks += n(row.metrics?.[0]);
    c.cost += n(row.metrics?.[1]);
  }
  for (const row of visits.data ?? []) {
    const c = campaign(row.dimensions?.[0]);
    c.visits += n(row.metrics?.[0]);
    c.users += n(row.metrics?.[1]);
    goalKeys.forEach((key, i) => (c.goals[key] = (c.goals[key] ?? 0) + n(row.metrics?.[2 + i])));
  }
  const campaigns = [...byId.values()]
    .filter((c) => c.cost || c.clicks || c.visits)
    .sort((a, b) => b.cost - a.cost || b.visits - a.visits);
  const goalsTotal = Object.fromEntries(goalKeys.map((key) => [key, campaigns.reduce((a, c) => a + (c.goals[key] ?? 0), 0)]));
  return {
    clients: logins.length,
    clicks: n(spend.totals?.[0]),
    cost: n(spend.totals?.[1]),
    visits: campaigns.reduce((a, c) => a + c.visits, 0),
    goals: goalsTotal,
    campaigns,
    byDay: Object.fromEntries(
      (spendByDay.data ?? []).map((row) => [row.dimensions?.[0]?.name, { clicks: n(row.metrics?.[0]), cost: n(row.metrics?.[1]) }]),
    ),
  };
}

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
    direct: await collectDirect(base, goal).catch((error) => ({ error: error.message })),
  };
}
