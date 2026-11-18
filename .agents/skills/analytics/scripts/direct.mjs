// Yandex Direct API v5, service Reports: spend, impressions, clicks and Direct's own conversions by campaign and by day
// for the advertiser's account. Read-only: nothing but reports is called.
// YANDEX_DIRECT_TOKEN — OAuth token (scope direct:api) of a user who can see the account; it is never printed.
// YANDEX_DIRECT_CLIENT_LOGIN — the advertiser's login, sent as Client-Login (the user's own account without it).
// YANDEX_DIRECT_API overrides the endpoint (the sandbox is https://api-sandbox.direct.yandex.com/json/v5).
const API = process.env.YANDEX_DIRECT_API || 'https://api.direct.yandex.com/json/v5';
// Metrika goals the campaigns are measured by (MetrikaGoal in events.ts): conversions come back per goal.
const GOALS = { openApp: 681279212, firstReply: 678454750, polz3: 681201713, dau10: 681201815 };
// Last significant click, the same model as the Metrika side of the report.
const MODEL = 'LSC';
const FIELDS = ['Date', 'CampaignId', 'CampaignName', 'Impressions', 'Clicks', 'Cost', 'Conversions'];
const MAX_WAIT_MS = 5 * 60_000;

export const directApiConfigured = () => Boolean(process.env.YANDEX_DIRECT_TOKEN);

const n = (v) => (v === '--' || v == null ? 0 : Number(v) || 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The report is built offline: 201/202 mean «not ready yet, ask again in retryIn seconds».
async function fetchReport(params) {
  const headers = {
    Authorization: `Bearer ${process.env.YANDEX_DIRECT_TOKEN}`,
    'Accept-Language': 'ru',
    'Content-Type': 'application/json; charset=utf-8',
    processingMode: 'auto',
    returnMoneyInMicros: 'false',
    skipReportHeader: 'true',
    skipReportSummary: 'true',
  };
  if (process.env.YANDEX_DIRECT_CLIENT_LOGIN) headers['Client-Login'] = process.env.YANDEX_DIRECT_CLIENT_LOGIN;
  const started = Date.now();
  for (;;) {
    const response = await fetch(`${API}/reports`, { method: 'POST', headers, body: JSON.stringify({ params }) });
    if (response.status === 200) return response.text();
    if (response.status === 201 || response.status === 202) {
      if (Date.now() - started > MAX_WAIT_MS) throw new Error('Direct API: отчёт не собрался за 5 минут');
      await sleep(Math.min(Number(response.headers.get('retryIn')) || 10, 60) * 1000);
      continue;
    }
    const body = await response.json().catch(() => ({}));
    const error = body.error ?? {};
    throw new Error(`Direct API HTTP ${response.status}: ${[error.error_code, error.error_string, error.error_detail].filter(Boolean).join(' ')}`.slice(0, 300));
  }
}

// from and to are Moscow dates, both included (Direct keeps the account's time zone, Moscow for Russian accounts).
export async function collectDirectApi({ from, to }) {
  const goalIds = Object.values(GOALS);
  const tsv = await fetchReport({
    SelectionCriteria: { DateFrom: from, DateTo: to },
    Goals: goalIds,
    AttributionModels: [MODEL],
    FieldNames: FIELDS,
    // A report is cached by its name: the same name with other parameters is an error, so the name carries them.
    ReportName: `ryadom-${from}-${to}-${MODEL}-v1`,
    ReportType: 'CAMPAIGN_PERFORMANCE_REPORT',
    DateRangeType: 'CUSTOM_DATE',
    Format: 'TSV',
    IncludeVAT: 'YES',
    IncludeDiscount: 'NO',
  });
  const [head, ...lines] = tsv.trim().split('\n').map((line) => line.split('\t'));
  const col = (name) => head.indexOf(name);
  // With Goals the conversions come as Conversions_<goal id>_<model>, one column per goal.
  const goalCols = Object.entries(GOALS).map(([key, id]) => [key, col(`Conversions_${id}_${MODEL}`)]);
  const byId = new Map();
  const byDay = {};
  const goalsTotal = Object.fromEntries(Object.keys(GOALS).map((key) => [key, 0]));
  let impressions = 0;
  let clicks = 0;
  let cost = 0;
  for (const row of lines) {
    if (row.length < head.length) continue;
    const id = row[col('CampaignId')];
    if (!byId.has(id)) byId.set(id, { name: row[col('CampaignName')], impressions: 0, clicks: 0, cost: 0, goals: {} });
    const c = byId.get(id);
    const day = row[col('Date')];
    const rowImpressions = n(row[col('Impressions')]);
    const rowClicks = n(row[col('Clicks')]);
    const rowCost = n(row[col('Cost')]);
    c.impressions += rowImpressions;
    c.clicks += rowClicks;
    c.cost += rowCost;
    impressions += rowImpressions;
    clicks += rowClicks;
    cost += rowCost;
    byDay[day] ??= { impressions: 0, clicks: 0, cost: 0 };
    byDay[day].impressions += rowImpressions;
    byDay[day].clicks += rowClicks;
    byDay[day].cost += rowCost;
    for (const [key, index] of goalCols) {
      if (index < 0) continue;
      c.goals[key] = (c.goals[key] ?? 0) + n(row[index]);
      goalsTotal[key] += n(row[index]);
    }
  }
  const campaigns = [...byId.values()].filter((c) => c.cost || c.clicks).sort((a, b) => b.cost - a.cost);
  return {
    source: 'api',
    model: MODEL,
    missingGoals: goalCols.filter(([, index]) => index < 0).map(([key]) => key),
    impressions, clicks, cost, goals: goalsTotal, campaigns, byDay,
  };
}
