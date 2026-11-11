# Дашборд метрик для Sber500

Отдельный сервис в своём namespace `dashboard`: страница `https://слышу-рядом.рф/dashboard` и JSON
`https://слышу-рядом.рф/dashboard/api` с тремя числами по дням за последние 7 полных суток по Москве.
Код и определения метрик — `dashboard/app.py`, спека — `openspec/specs/sber500-dashboard`.

Сервисы agent и api дашборд не трогает. Он сам читает базу `agent` в сессии только на чтение и API метрик Langfuse,
пересчитывает раз в час и отдаёт наружу только суммы. Вход — basic auth (логин `sber500`), неудачные входы ограничены
по IP.

## Secret

`dashboard-secrets` в ns `dashboard` собирается из Lockbox `ryadom-app-secrets` помощником создания Secret'ов, сначала
с `--dry-run=server`. Значения хранятся у администратора.

| Ключ Secret'а | Ключ в Lockbox |
|---|---|
| `DIALOG_DATABASE_URL` | `AGENT_DIALOG_DATABASE_URL` (то же значение, что в Secret `agent-db` агента) |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | `AGENT_LANGFUSE_PUBLIC_KEY`, `AGENT_LANGFUSE_SECRET_KEY` (то же, что в `agent-secrets`) |
| `DASHBOARD_PASSWORD` | `DASHBOARD_PASSWORD` |

Если у агента сменились пароль базы или ключи Langfuse, сначала обновляется Lockbox, затем Secret дашборда
пересоздаётся. `registry-pull` в ns `dashboard` — копия общего секрета реестра из ns `agent` (в Lockbox его нет).

## Выкат

Применять поимённо, admin-kubeconfig:

```bash
kubectl apply -f k8s/dashboard/00-namespace.yaml -f k8s/dashboard/01-network-policy.yaml
# В живой ryadom-db-allow-ingress есть ns, которых нет в репозитории: не apply файлом, а patch одной строкой
kubectl -n ryadom-db patch networkpolicy ryadom-db-allow-ingress --type json \
  -p '[{"op":"add","path":"/spec/ingress/0/from/-","value":{"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"dashboard"}}}}]'
# из 02-network-policy-infra.yaml — только политика infra-allow-ingress-dashboard-langfuse
# Secret'ы dashboard-secrets и registry-pull
kubectl apply -f k8s/dashboard/02-deployment.yaml -f k8s/dashboard/03-service.yaml -f k8s/dashboard/04-httproute.yaml
kubectl -n dashboard rollout status deploy/dashboard --timeout=120s
```

Образ: `cr.yandex/crpsqeamqpuvrkm5tpr9/app/dashboard:<версия>`, собирается из `dashboard/` под `linux/amd64`.

## Проверка

- `curl -sI https://слышу-рядом.рф/dashboard` → 401; с логином и паролем → 200.
- `/dashboard/api` отдаёт 7 дней.
- В журнале пода `пересчитано за …` раз в час, ошибок подключения нет.

## Удаление

`kubectl delete ns dashboard`, затем убрать строку `dashboard` из `ryadom-db-allow-ingress` и политику
`infra-allow-ingress-dashboard-langfuse` (или оставить: без namespace они ничего не открывают).
