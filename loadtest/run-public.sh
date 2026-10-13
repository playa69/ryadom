#!/usr/bin/env bash
# Публичный нагрузочный прогон против https://слышу-рядом.рф — как реальный
# пользователь, без kubectl. Пул аккаунтов готовится заранее (pool.py),
# регистрация и логин под нагрузкой НЕ дёргаются.
#
# Использование (из корня репозитория):
#   loadtest/.venv/bin/python loadtest/pool.py create 30     # один раз
#   loadtest/run-public.sh                    # 30 пользователей, 20 минут
#   loadtest/run-public.sh 30 3m              # короткий смоук
#
# На выходе в loadtest/out/<run>-public*.{csv,html,docx}:
#   HTML — классический отчёт Locust, DOCX — расшифровка на русском.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/loadtest"
RUN_ID="$(date +%Y%m%d-%H%M%S)-public"
USERS="${1:-30}"
RUN_TIME="${2:-20m}"
SPAWN="${3:-1}"

# Свежие access-токены всему пулу перед прогоном (TTL 15 минут).
.venv/bin/python pool.py refresh-all

.venv/bin/locust -f locustfile_public.py --headless \
  --users "$USERS" --spawn-rate "$SPAWN" --run-time "$RUN_TIME" \
  --csv "out/$RUN_ID" --html "out/$RUN_ID.html" --only-summary || true

.venv/bin/python report.py "out/$RUN_ID" \
  --title "Публичный прогон $RUN_ID: $USERS виртуальных пользователей, $RUN_TIME, через слышу-рядом.рф" \
  -o "out/$RUN_ID.docx"
