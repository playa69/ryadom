---
name: ryadom-twc-cluster
description: "Проект Рядом (ryadom) живёт в кластере Timeweb Cloud twc-sber500. Используй ВСЕГДА этот кластер для ryadom: kubectl через admin-kubeconfig.yaml, namespaces agent/ryadom-db/infra/prod, БД app/agent в ryadom-db, Langfuse в infra. НЕ путать с кластером yc-seven-element (Seven Element — другой проект)."
---

# Рядом = Timeweb Cloud (twc-sber500)

**Жёсткое правило:** для проекта Рядом (корень этого репозитория)
вся инфраструктура — только кластер **Timeweb Cloud `twc-sber500`**.
Никогда не ходить в `yc-seven-element` (Yandex Cloud) — это проект Seven Element, другой клиент.

## Подключение

```bash
export KUBECONFIG=<корень репозитория>/admin-kubeconfig.yaml
# context: twc-sber500; адрес API-сервера лежит в самом kubeconfig
```

- `admin-kubeconfig.yaml` (корень репо) — полный доступ (cluster-admin).
- `developer-kubeconfig.yaml` — ограниченный (user `developer`), для обычных операций.
- Дефолтный `~/.kube/config` указывает на чужой кластер — всегда задавать `KUBECONFIG` явно.

## Namespaces

| Namespace | Что там |
|---|---|
| `agent` | AI-агент + Cognee (`svc/cognee:8000`, память агента, только внутри кластера) |
| `prod` | app API (мобильное приложение, пользователи) |
| `ryadom-db` | PostgreSQL CNPG-кластер `ryadom-db` (primary `ryadom-db-1`) + Redis |
| `infra` | Langfuse (`svc/langfuse-web:3000`), clickhouse, redis |
| `monitoring` | мониторинг |

Если в кластере ещё есть namespace `backend` или база `backend` — это остатки удалённого
Python-сервиса (PROTEUS-250): не использовать, их снимает администратор.

## База данных

Кластер CNPG `ryadom-db` в ns `ryadom-db`, primary — `ryadom-db-1`.

Базы внутри:
- **`app`** — пользователи мобильного приложения: `users` (email citext, telegram_id, is_deleted, last_active_at), `user_credentials`, `email_codes`, `refresh_tokens`, `user_devices`, `user_consents`.
- **`agent`** — данные агента.
- **`cognee_db`** — Cognee (память агента, роль `cognee`, расширение vector).
- `langfuse` — БД лангфьюза, не трогать.

Запросы через exec в под primary:

```bash
kubectl exec -n ryadom-db ryadom-db-1 -- psql -U postgres -d app -c "SELECT count(*) FROM users;"
```

## Langfuse

```bash
kubectl port-forward -n infra svc/langfuse-web 3000:3000
# → http://localhost:3000
```

## Манифесты

`k8s/` в репо: app, agent, postgres, redis, langfuse, istio, monitoring, tls.
Конфиг кластера: `k8s/twc-sber500-config.yaml`.
