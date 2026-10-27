---
name: analytics
description: Product analytics for Ryadom in PostHog (EU, project 300786) — HogQL queries via the API for DAU, funnels, retention, dialogs and turns, platforms, UTM, crisis signals, reconciliation with the database. Use for questions like "how many people talked", "what is the DAU", "registration funnel", "retention", "where did they come from", "how many turns per day", "how many real users", when preparing metrics and when checking events after a rollout.
---

# Product analytics (PostHog)

The `Ryadom` project in PostHog Cloud EU, id `300786`. How collection works, what is sent and what is not, the event
catalog — [docs/analytics.md](../../../docs/analytics.md); what counts as the target action and how the numbers are
reconciled with the databases — [docs/analytics-proof.md](../../../docs/analytics-proof.md). Event and property types —
`app/packages/analytics/src/events.ts`.

## Access

```bash
node .agents/skills/analytics/scripts/hogql.mjs "SELECT count() FROM events WHERE timestamp > now() - INTERVAL 1 DAY"
node .agents/skills/analytics/scripts/hogql.mjs -f /tmp/dau.sql --json
```

The script sends HogQL to `POST /api/environments/300786/query/` and prints a table (`--json` prints columns and rows
as JSON). It needs a personal PostHog key with the `query:read` scope in `POSTHOG_PERSONAL_API_KEY`; the administrator
issues it, and it never goes into chat or repository files. The public project token `phc_…` (`POSTHOG_KEY`) does not
work for queries: it only accepts events.

Without a key, from a browser where the user is signed in to `eu.posthog.com`, the same query is made by `fetch` from
the project page (the session and the `X-CSRFToken` header taken from the `posthog_csrftoken` cookie); this works only
while the tab is open on `eu.posthog.com`. The `app.posthog.com` web UI answers 403 "not available in your region" from
some regions — use `eu.posthog.com`.

**Change nothing in the project without a direct request:** dashboards, insights, cohorts, project settings, people.
Queries are read-only.

## People filter

Any count of people starts by excluding test and team traffic:

```sql
WHERE person_id NOT IN COHORT 275976                                   -- load test of 13 Oct, 150 accounts
  AND coalesce(properties.app_env, '') NOT IN ('local', 'staging', 'development')
  AND coalesce(properties.traffic_type, 'real') NOT IN ('test', 'internal')
```

`traffic_type` is set by the server per account (`users.properties.traffic_type`): `test` — devices with an id starting
with `loadtest-`, `internal` — the team, marked manually. Accounts from new load-test runs must be appended to cohort
275976 (the query is in docs/analytics.md, section «Дашборды и тестовые данные») — this changes the project, so only on request.

## Cheat sheet

```sql
-- People who talked, and turns per day (Moscow)
SELECT toDate(toTimeZone(timestamp, 'Europe/Moscow')) AS day,
       uniqIf(person_id, event = 'dialog_turn') AS people, countIf(event = 'dialog_turn') AS turns,
       countIf(event = 'component_called') AS calls
FROM events WHERE timestamp > now() - INTERVAL 14 DAY AND <people filter>
GROUP BY day ORDER BY day

-- Said anything at all: dialog_turn appeared on the evening of 13 Oct, before it there were counters at the end of a dialog
SELECT count(DISTINCT person_id) FROM events
WHERE (event = 'dialog_turn' OR (event IN ('dialog_ended', 'dialog_interrupted') AND toInt(properties.user_messages) > 0))
  AND <people filter>

-- Platforms and sources
SELECT properties.app_platform, count(DISTINCT person_id) FROM events WHERE event = 'app_opened' AND <filter> GROUP BY 1
SELECT properties.$session_entry_utm_source AS source, count(DISTINCT person_id) FROM events
WHERE event = 'account_created' AND <filter> GROUP BY source ORDER BY 2 DESC LIMIT 50

-- Retention: came back with a turn a day or more after the first one
SELECT count() FROM (
  SELECT person_id, minIf(timestamp, event = 'dialog_turn') AS first, maxIf(timestamp, event = 'dialog_turn') AS last
  FROM events WHERE event = 'dialog_turn' AND <people filter> GROUP BY person_id)
WHERE last >= first + INTERVAL 24 HOUR

-- Crisis signals and SOS: events without a person, time rounded to the hour
SELECT event, properties.level, count() FROM events
WHERE event IN ('safety_signal', 'sos_opened', 'hotline_called') AND timestamp > now() - INTERVAL 7 DAY GROUP BY 1, 2
```

The target action (`dialog_turn`) and the DAU based on it are defined in docs/analytics-proof.md: count by those
definitions, and if the task asks for something else (for example, "a dialog of three or more turns"), state it
explicitly in the report. Ready-made cards are in the dashboards «Рядом — продукт»
(`https://eu.posthog.com/project/300786/dashboard/1012431`) and «Рядом — воронка и удержание» (`…/dashboard/1020753`).

## Reconciliation with the database

PostHog is reconciled with the databases (the `db` skill): the `dialog_id` of events = `dialogs.id` in the `agent`
database, `person_id` = the account id (`users.id` in the `app` database). To intersect them, export both lists to files
outside the repository and match them with a script; people who talked before 10 Oct 2026 are in the database but not in
PostHog (there was no analytics yet).

## Pitfalls

- **100 rows by default.** HogQL silently truncates the response if the query has no `LIMIT`; the script warns.
- **Time** in `timestamp` is UTC: for Moscow days use `toTimeZone(timestamp, 'Europe/Moscow')`.
- **Types.** `greatest()` and comparisons between `Int64` and `UInt64` fail: cast explicitly or compute in a script.
- **Events without a person** (`safety_signal`, `password_reset_requested`, `account_deleted`, SOS and helplines) carry
  a random id and a time rounded to the hour: do not count people from them and do not match them with a person's
  actions.
- **`app_version`** is the image tag (`--build-arg RELEASE`); `0.1.0` means the image was built without it.
- **Do not export the properties of people and events in full:** only aggregates go into reports and issues.

Related: [[db]] — the same people and dialogs in the databases; [[logs]] — model spend and tokens (Prometheus,
Langfuse).
