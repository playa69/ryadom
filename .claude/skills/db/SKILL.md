---
name: db
description: Run a query against the Ryadom production database — the PostgreSQL cluster CNPG ryadom-db (databases app, agent, cognee_db) via psql in the primary pod, read-only by default. Use for questions like "look in the database", "how many users", "what account is this", "how many dialogs per day", "find a dialog by id", when reconciling analytics with the database, and when editing production data at the direct request of the user.
---

# Production database

A single PostgreSQL 16 cluster under the CloudNativePG operator: `ryadom-db` in ns `ryadom-db`, two instances, the primary
is found by label. There is a single environment — production; for a local database see skill `local-dev`.

| Database | Owner | Contents | Schema |
|---|---|---|---|
| `app` | role `app` | application accounts: `users`, `user_credentials`, `user_devices`, `user_consents`, `refresh_tokens`, `email_codes`, `audit_log`, `memory_consent_events` | `app/packages/db/src/schema/`, drizzle migrations |
| `agent` | role `agent` (since 0.8.0) | agent dialogs: `dialogs`, `messages`, `model_usage`, `voice_prefs`, `client_ids` | `agent/app/services/dialog_db.py` (the agent creates it itself) |
| `cognee_db` and databases like `"<uuid>"` | role `cognee` | agent memory, one database per tenant | managed by Cognee, do not touch by hand |
| `langfuse` | — | Langfuse | do not touch |

## Permission

This is the data of real people, including the texts of their conversations. **Read production only at the explicit
request of the user** in this issue or chat; write only at a separate request, following the protocol below. `exec` into
`ryadom-db` is available only to admin, so every access is an admin access: name the query you will run and wait for the
user's explicit "yes".

## Query

```bash
.agents/skills/db/scripts/query.py app "SELECT count(*) FROM users WHERE NOT is_deleted"
.agents/skills/db/scripts/query.py agent -f /tmp/dialogs-by-day.sql --csv
```

The script finds the primary pod, runs `psql -U postgres` in it over the local socket (no password is needed, and none is
printed) and opens the session with `default_transaction_read_only`: any write will fail. `--write` removes the
protection — do not add it without a direct request. `--csv` — output for further processing. The script takes the
kubectl command from `RYADOM_KUBECTL_ADMIN` (default `kubectl`).

The same thing without the script:

```bash
POD=$(kubectl -n ryadom-db get pod -l cnpg.io/cluster=ryadom-db,cnpg.io/instanceRole=primary -o name)
kubectl -n ryadom-db exec -i "$POD" -c postgres -- psql -U postgres -d app -X -v ON_ERROR_STOP=1 < query.sql
```

The `developer` role has no rights to the `app` and `agent` databases: only `exec` into the primary pod, which means
admin. If the cluster still has a `backend` database, it is a leftover of the removed Python service: do not use it; the
administrator removes it.

## Cheat sheet

```sql
-- Accounts per day (Moscow time), excluding test and team accounts
SELECT (created_at AT TIME ZONE 'Europe/Moscow')::date AS day, count(*)
FROM users WHERE coalesce(properties->>'traffic_type', 'real') NOT IN ('test', 'internal')
GROUP BY 1 ORDER BY 1;

-- Dialogs and messages per day (agent database; time there is ISO text in UTC)
SELECT (started_at::timestamptz AT TIME ZONE 'Europe/Moscow')::date AS day, count(*) AS dialogs,
       count(DISTINCT user_id) AS people
FROM dialogs GROUP BY 1 ORDER BY 1;

-- Size of a conversation without texts
SELECT d.id, d.user_id, d.started_at, count(m.*) FILTER (WHERE m.role = 'user') AS user_messages
FROM dialogs d LEFT JOIN messages m ON m.dialog_id = d.id
WHERE d.started_at > (now() - interval '1 day')::text GROUP BY d.id ORDER BY d.started_at DESC LIMIT 20;

-- Model usage over the last day
SELECT model, task, direction, unit, sum(amount) FROM model_usage
WHERE created_at > (now() - interval '1 day')::text GROUP BY 1, 2, 3, 4;
```

Check columns against the schema or with a query to `information_schema.columns`: the agent's tables change together
with its version. Ready-made queries for reconciling with analytics are in `docs/analytics-proof/` (written for the
agent's former SQLite database; for PostgreSQL fix the date functions).

## Data edits

Only at the direct request of the user.

1. Reconnaissance by reading: which rows the edit will affect, and how many.
2. The same `WHERE` in a `SELECT count(*)`; give the number to the user.
3. A rollback point: the old values into a file outside the repository; for a bulk edit or a schema change — a fresh
   backup (skill `backup`).
4. One `--write` transaction, inside it a check for exactly the expected number of rows, otherwise `ROLLBACK`.
5. Verify the result by reading.

Deleting an account is not SQL but the API (`DELETE /api/auth/me` on behalf of the account) or the admin panel: that also
erases the data at the agent and the profile in PostHog.

## Pitfalls

- **Time.** In `app` it is `timestamptz`, in `agent` it is ISO text in UTC (`…Z`); people count days in Moscow time
  (UTC+3).
- **Test accounts.** `users.properties->>'traffic_type'` = `test` (devices `loadtest-…`) or `internal` (the team) —
  exclude them from any counts of people.
- **Deleted accounts remain as rows** (`is_deleted`, `deleted_at`); `properties.deletion` holds an archive of personal
  data — do not select it.
- **Links between databases.** `dialogs.user_id` (text) = `users.id` (uuid), `dialogs.id` = `dialog_id` of the PostHog
  events. A join between databases is impossible: two queries and matching in a file outside the repository.
- **`$$` in a shell string** expands to the PID — do not use dollar-quoting in `-c`, put the SQL in a file.
- The application images have neither psql nor a driver for manual queries: only the `postgres` container of the
  primary pod.

## Security

Read conversation texts (`messages.text`, `dialogs.summary`) only if the user asked to analyze a conversation. Email,
names and conversation contents do not go into reports, issues, commits, PRs, tests and fixtures: there, use anonymized
numbers and synthetic phrases. Keep dumps outside the repository and delete them after the work.

Related: [[backup]] — backups and dumps; [[logs]] — where `userId` and `dialogId` come from; [[analytics]] — the same
people in PostHog.
