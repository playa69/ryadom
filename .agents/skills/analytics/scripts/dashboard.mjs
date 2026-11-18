// The Sber500 dashboard (/dashboard/api, spec openspec/specs/sber500-dashboard): the team's daily figures exactly as the
// organizers see them — DAU, active accounts, new and total users, LLM requests and memory tool calls. The report
// takes them as they are instead of counting them again: the dashboard joins the agent's database with Langfuse
// (the database lost the messages of 11–16.11.2026), and a second implementation would drift from it.
// Read-only, sums only. Basic auth: DASHBOARD_USER (default sber500) and DASHBOARD_PASSWORD, which is never printed.
// DASHBOARD_URL overrides the address.
const DEFAULT_URL = 'https://xn----htbtgjker8b3a2c.xn--p1ai/dashboard/api';
const FIELDS = ['dau', 'daily_active_account', 'new_users', 'total_users', 'llm_requests', 'tool_requests'];

export const dashboardConfigured = () => Boolean(process.env.DASHBOARD_PASSWORD);

// from and to are Moscow dates, both included. Days the dashboard does not have (before the contest, 05.11.2026)
// stay out of the answer: the report shows a dash for them, not a zero.
export async function collectDashboard({ from, to }) {
  const user = process.env.DASHBOARD_USER || 'sber500';
  const auth = Buffer.from(`${user}:${process.env.DASHBOARD_PASSWORD}`).toString('base64');
  const response = await fetch(process.env.DASHBOARD_URL || DEFAULT_URL, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`dashboard: HTTP ${response.status}`);
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body?.days)) throw new Error('dashboard: no days in the answer');
  // The last day of the dashboard is the current one: preliminary, not closed by a snapshot yet.
  const current = body.period?.to ?? null;
  const days = {};
  for (const row of body.days) {
    if (typeof row?.date !== 'string' || row.date < from || row.date > to) continue;
    days[row.date] = Object.fromEntries(FIELDS.map((field) => [field, Number(row[field]) || 0]));
    if (row.date === current) days[row.date].preliminary = true;
  }
  return { updatedAt: body.updated_at ?? null, contestFrom: body.period?.from ?? null, days };
}
