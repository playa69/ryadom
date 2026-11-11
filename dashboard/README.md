# dashboard — метрики для Sber500

Один файл `app.py` (Python 3.12, стандартная библиотека и psycopg): страница `/dashboard` и JSON `/dashboard/api`
с тремя числами по московским суткам за последние 7 полных суток.

- **Активные (DAU)** — люди, у которых больше 10 реплик за сутки (база агента).
- **Вызовы LLM** — трассы Langfuse за сутки, все вызовы моделей агента.
- **Пользователи** — аккаунты, у которых за всё время больше 3 реплик, нарастающим итогом (база агента; разговоры в
  ней есть с агента 0.8.0).

Тестовые аккаунты не исключаются. Пересчёт не чаще раза в час, наружу только суммы. Выкат, Secret и сеть —
`k8s/dashboard/README.md`.

```bash
uv run --no-project --python 3.12 --with pytest pytest -q tests          # тесты чистых функций
uv run --no-project --with ruff ruff check --line-length 130 .
```

Переменные: `DASHBOARD_USER` (по умолчанию `sber500`), `DASHBOARD_PASSWORD` (без неё сервис не стартует),
`DIALOG_DATABASE_URL`, `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `PORT` (8080).
