## 0. Решения

- [x] 0.1 Определения, источники, окно 7 дней, адреса, вход и отдельный namespace согласованы с владельцем 11.11.2026. Приёмка: записаны в `proposal.md` и `design.md`.

## 2. Сервис

- [x] 2.1 `dashboard/app.py`: расчёт по базе агента и Langfuse, кэш на час, basic auth, ограничение неудачных входов, страница и JSON. Приёмка: `uv run --no-project --python 3.12 --with pytest pytest -q tests` из `dashboard/` зелёный, `ruff check` чистый.
- [x] 2.2 `dashboard/Dockerfile`, пользователь 10001, `requirements.txt` с закреплённой версией psycopg. Приёмка: образ собирается под linux/amd64.

## 6. Выкат

- [x] 6.1 `k8s/dashboard/`: namespace, сетевые политики, Deployment, Service, HTTPRoute; разрешения для ns `dashboard` в `k8s/postgres/manifests/03-network-policy.yaml` и `k8s/namespaces/manifests/02-network-policy-infra.yaml`. Приёмка: `kubectl apply --dry-run=server` без ошибок.
- [ ] 6.2 Secret'ы и выкат в прод. Приёмка: `curl -sI https://слышу-рядом.рф/dashboard` → 401, с паролем → 200, `/dashboard/api` отдаёт 7 дней, числа за 05–10.11 совпадают со сверкой по базе и Langfuse.

## 7. Архив

- [ ] 7.1 Архивировать change после выката.
