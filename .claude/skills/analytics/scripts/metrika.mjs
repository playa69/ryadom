// Yandex Metrika (the counter «Слышу Рядом») through the Reports API: totals and goals for the reconciliation, and who
// comes (age, gender) with the share that reaches a 3+ reply dialog. Read-only.
// The OAuth token (scope metrika:read) comes from YANDEX_METRIKA_TOKEN; it is never printed.
// YANDEX_METRIKA_COUNTER overrides the counter.
const API = 'https://api-metrika.yandex.net';
const COUNTER = process.env.YANDEX_METRIKA_COUNTER || '114043323';
// «Переход в продукт»: a page goal; the two JS goals are found by their identifiers (MetrikaGoal in events.ts).
const PRODUCT_GOAL_ID = 678475442;

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
  const goal = {
    product: goals.find((g) => g.id === PRODUCT_GOAL_ID),
    reply: goalBy(goals, 'first_reply'),
    d3: goalBy(goals, 'first_dialog_3_replies'),
  };
  const found = Object.entries(goal).filter(([, g]) => g);
  const base = { ids: COUNTER, date1: from, date2: to, accuracy: 'full' };

  const metrics = ['ym:s:visits', 'ym:s:users', ...found.map(([, g]) => `ym:s:goal${g.id}users`)];
  const summary = await get('/stat/v1/data', { ...base, metrics: metrics.join(',') });
  const totals = summary.totals ?? [];
  const goalUsers = Object.fromEntries(found.map(([key], i) => [key, Number(totals[2 + i]) || 0]));

  const audience = async (dimension) => {
    if (!goal.d3) return [];
    const body = await get('/stat/v1/data', {
      ...base,
      dimensions: dimension,
      metrics: `ym:s:users,ym:s:goal${goal.d3.id}users`,
      sort: dimension,
      limit: 20,
    });
    return (body.data ?? []).map((row) => ({
      label: row.dimensions?.[0]?.name ?? '—',
      users: Number(row.metrics?.[0]) || 0,
      d3: Number(row.metrics?.[1]) || 0,
    }));
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
