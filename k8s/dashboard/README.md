# Дашборд метрик для Sber500

Отдельный сервис в своём namespace `dashboard`: страница `https://слышу-рядом.рф/dashboard` и JSON
`https://слышу-рядом.рф/dashboard/api` с тремя числами по дням за последние 7 полных суток по Москве.
Код и определения метрик — `dashboard/app.py`, спека — `openspec/specs/sber500-dashboard`.

Сервисы agent и api дашборд не трогает. Он сам читает базу `agent` в сессии только на чтение и API метрик Langfuse,
пересчитывает раз в час и отдаёт наружу только суммы. Вход — basic auth (логин `sber500`), неудачные входы ограничены
по IP.

## Secret

`dashboard-secrets` в ns `dashboard`, значения хранятся у администратора. Создаётся при выкате, как остальные Secret'ы
кластера, сначала с `--dry-run=server`:

| Ключ | Откуда |
|---|---|
| `DIALOG_DATABASE_URL` | то же значение, что в Secret `agent-db` агента |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | то же, что в Secret `agent-secrets` агента |
| `DASHBOARD_PASSWORD` | пароль входа для организаторов |

Если у агента сменились пароль базы или ключи Langfuse, Secret дашборда пересоздаётся с теми же значениями.
`registry-pull` в ns `dashboard` — тот же, что в ns `agent`.

## Выкат

Применять поимённо, admin-kubeconfig:

```bash
kubectl apply -f k8s/dashboard/00-namespace.yaml -f k8s/dashboard/01-network-policy.yaml
kubectl apply -f k8s/postgres/manifests/03-network-policy.yaml
kubectl apply -f k8s/namespaces/manifests/02-network-policy-infra.yaml   # сначала kubectl diff
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
