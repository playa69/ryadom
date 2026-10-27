---
name: logs
description: Read Ryadom production logs and metrics and monitor production — kubectl logs of pods (agent, app-api and the rest), Loki (LogQL, 7 days), Prometheus (PromQL, agent metrics), the agent /health and /metrics, Langfuse. Use for questions like "what is in the logs", "what errors are there in production", "why did it crash", "why was the agent silent", "how many quota errors", "watch production after a rollout", when investigating incidents and when tying an error to a dialog or a person.
---

# Production logs and monitoring

There is one cluster, Timeweb `twc-sber500`, and a single environment — production. Applications write to stdout, Alloy
collects it into Loki, and Prometheus collects the metrics. Nothing is published externally: access is only through
`kubectl logs` and `port-forward`. For the layout of the stack see `k8s/README.md`, section «Мониторинг: Prometheus + Loki + Grafana».

## Access

`kubectl` below is the command to the cluster on this machine; what it connects with (kubeconfig, wrapper) is known to
the administrator. The skill script takes it from `RYADOM_KUBECTL_ADMIN` (default: plain `kubectl`).

| Where | developer | admin |
|---|---|---|
| logs and port-forward in `agent`, `ryadom-db`, `infra` | yes | yes |
| `prod` (app-api, app-web, app-admin, app-landing, app-pwa) | no, not even reading | yes |
| `monitoring` (Loki, Prometheus, Grafana) | no | yes |
| `exec` into pods | nowhere | yes |

Default is developer. **Use admin only after the user's explicit "yes" for a specific read** (`prod` logs, Loki,
Prometheus): say in one message what you will read and for which window, and change nothing.

## Where things are

| ns | Deployment | `-c` | What is in the log |
|---|---|---|---|
| prod | app-api | api | JSON: `level`, `time`, `msg`, `component`, `userId`, `dialogId`, `codec` |
| prod | app-web, app-admin, app-landing | web, admin, landing | Next.js |
| prod | app-pwa | pwa | nginx |
| agent | agent | agent | text: `dialog started`, `socket opened/closed`, `first sound`, `live timeline`, `live usage`, `WARNING` |
| agent | cognee | cognee | agent memory |
| infra | langfuse-web | — | LLM tracing (a UI, not a log) |

Always specify `-c`: in pods with an Istio sidecar, `--all-containers` mixes in `istio-proxy` noise.

## kubectl logs

```bash
kubectl -n agent logs deploy/agent -c agent --since=30m --timestamps > agent.log
kubectl -n prod logs deploy/app-api -c api --since=10m | grep -E '"level":"(warn|error)"'      # admin
kubectl -n agent logs deploy/agent -c agent --since=20m | grep -cE 'socket opened|dialog started'  # live dialogs
```

- Returns only the live pod. The agent uses the `Recreate` strategy: after a rollout the log of the previous pod exists
  only in Loki.
- Without `--since` or `--tail` the command runs for a long time; an hour of the agent log under load weighs about 8 MB,
  so dump it to a file outside the repository and analyze it with a script.

## Loki (7 days)

```bash
.agents/skills/logs/scripts/monitoring.py loki '{namespace="agent",container="agent"} |~ "WARNING|ERROR|Traceback"' 2h
.agents/skills/logs/scripts/monitoring.py loki '{namespace="prod",container="api"} |= "<dialogId>"' 2026-10-14T10:00:00Z 2026-10-14T11:00:00Z
.agents/skills/logs/scripts/monitoring.py loki 'sum(count_over_time({namespace="agent",container="agent"} |= "exceeded your current quota" [5m]))' 6h
```

The script brings up a port-forward to `svc/loki` (admin), queries `query_range` and prints lines as `time  pod  line`
(LogQL metrics as series). `--raw` — the raw JSON, `--limit N` — the line ceiling (5000 for Loki).

- Labels: `namespace`, `container`, `pod`, `app`, `service_name`, `job`, `instance`.
- The api log is JSON: `{namespace="prod",container="api"} | json | level="error"`; levels per minute —
  `sum by (level) (count_over_time({namespace="prod",container="api"} | json | __error__="" [1m]))`.
- Agent noise is cut off like this: `!= "GET /" != "POST /" != "connection open" != "WebSocket /"`.
- Cut long windows into 30-minute chunks: Loki will not return more than 5000 lines. Write a parenthesis in a regex as
  `[)]`, not `\\)`.

## Prometheus (14 days)

```bash
.agents/skills/logs/scripts/monitoring.py prom 'sum by (purpose, result) (increase(agent_gemini_opens_total[1h]))'
.agents/skills/logs/scripts/monitoring.py prom 'sum by (response_code) (rate(istio_requests_total{reporter="destination",destination_service_name="app-api"}[5m]))' 3h --step 300
```

Without a window — the current value; with a window — a series with a step of `--step` seconds.

| What | PromQL |
|---|---|
| restarts | `kube_pod_container_status_restarts_total{namespace=~"prod\|agent"}` |
| readiness | `kube_pod_status_ready{namespace=~"prod\|agent",condition="true"}` |
| memory and CPU | `container_memory_working_set_bytes{namespace="agent",container="agent"}`, `rate(container_cpu_usage_seconds_total{namespace="agent",container="agent"}[5m])` |
| WebSocket upgrades to api | `sum(rate(istio_requests_total{reporter="destination",destination_service_name="app-api",response_code="101"}[5m]))` |
| Gemini budget | `agent_gemini_tpm_window_tokens`, `agent_gemini_tpm_limit_tokens`, `agent_gemini_budget_level`, `increase(agent_gemini_quota_errors_total[1h])` |
| model usage | `agent_model_usage_total` (labels `model`, `task`, `direction`, `modality`, `unit`), `agent_component_calls_total` |
| agent database and memory | `agent_dialog_db_errors_total`, `agent_memory_*`, `process_resident_memory_bytes` |

The full list of agent metrics and what they mean is in `agent/README.md`. Grafana exists (`svc/prometheus-grafana`),
but these two APIs are enough for reading.

## The agent directly (developer)

```bash
kubectl -n agent port-forward deploy/agent 18001:8001 & pf=$!; sleep 5
curl -s localhost:18001/health/ready; curl -s localhost:18001/version
curl -s localhost:18001/metrics | grep '^agent_'
kill $pf
```

`/health/ready` shows the pipeline (`pipeline`), voice synthesis (`tts`), dialog storage (`dialogs`: `postgres` is
normal, `memory` — the database did not open) and the memory mode (`memory`).

## Langfuse

`kubectl -n infra port-forward svc/langfuse-web 3000:3000` (developer) → `http://localhost:3000`; the administrator holds
the login. Message texts are not written to traces (`LANGFUSE_TRACE_TEXT=false`); for tokens, Langfuse is the source of
truth; the cost there is 0, model prices are not set. The Langfuse project keys exist only in the environment of the
agent pod: do not take them out of the pod; run a read-only script against its API inside the pod itself
(`kubectl exec -i -n agent deploy/agent -c agent -- python - < script.py`, admin).

## Error → dialog → person

- The api log has `userId` and `dialogId`; the agent socket path is `/v1/users/<userId>/dialogs/<dialogId>/ws`.
- `dialog_id` is the same in PostHog, in the logs and in the agent database (skills `analytics` and `db`).
- Order: find the `dialogId` (a PostHog event or a database row) → Loki `|= "<dialogId>"` in `agent` and `prod` for the
  time window of the dialog.

## After a rollout

1. `kubectl -n <ns> rollout status deploy/<name> --timeout=300s`; the pod is Ready, restarts 0.
2. Agent: the startup log has `dialog db opened`, `agent started: pipeline=… memory=…`,
   `прогрев озвучки закончен: озвучено N, не удалось 0`; then `grep -E ' (WARNING|ERROR|CRITICAL) |Traceback'`.
3. api: `--since=10m` without `"level":"error"`, and "Redis подключён" is present.
4. The agent's `/health/ready` and `/version`; from outside `curl -sI https://xn----htbtgjker8b3a2c.xn--p1ai/api/health`,
   `/app`, `/pwa/`.
5. Automatic checks — `k8s/postdeploy` (skill `deploy`).
6. Long observation — a background command polling every 5–10 minutes; post only anomalies and the result to the chat or
   the issue.

## Pitfalls

- **Time.** Logs, Loki and Prometheus are in UTC, people speak in Moscow time (UTC+3).
- **Retention.** Loki — 7 days, Prometheus — 14 days or 3 GB, `kubectl logs` — only the live pod.
- **People's dialogs.** Message texts are not written to the log; if something personal does turn up, it does not go into
  reports, issues, commits and PRs. Log dumps — only outside the repository.
- **Noise, not an alarm:** `Forwarding`/`Handling` lines from port-forward, `GET /health`, `fsnotify … too many open files`
  from istio-proxy, the routine `live timeline`, `live usage`, `first sound`.
- **A network failure is not an answer.** A TLS timeout to the cluster API or the registry (happens behind a VPN) does
  not mean the resource does not exist.
- **`ImagePullBackOff` with `no match for platform`** — the image was not built for `linux/amd64` (skill `deploy`).

Related: [[deploy]] — what was rolled out and when; [[db]] — data by `userId` and `dialogId`; [[analytics]] — PostHog
events.
