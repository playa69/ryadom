#!/usr/bin/env bash
# Прогон нагрузочного теста агента в кластере twc + Word-отчёт.
#
# Что делает:
#   1. Поднимает kubectl port-forward к svc/agent (ClusterIP, наружу не торчит);
#   2. Достаёт AGENT_INTERNAL_TOKEN из k8s-секрета (только в env, не на диск);
#   3. Гоняет Locust headless со ступенчатым ростом до ~10 RPS ходов диалога;
#   4. Собирает Word-отчёт loadtest/out/<run>-report.docx.
#
# Запуск (из корня репозитория):
#   loadtest/run.sh                 # полный прогон ~26 мин, до 200 пользователей
#   loadtest/run.sh short           # короткий смоук: 5 пользователей, 3 минуты
#
# ВНИМАНИЕ: тест ходит в ПРОД-агента — тратятся токены LLM (Gemini relay),
# в БД пишутся тестовые диалоги (стираются на выходе, REST erase_user).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export KUBECONFIG="${KUBECONFIG:-$REPO_ROOT/admin-kubeconfig.yaml}"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$REPO_ROOT/loadtest/out"
mkdir -p "$OUT_DIR"

export AGENT_BASE_URL="http://localhost:18001"
export AGENT_INTERNAL_TOKEN
AGENT_INTERNAL_TOKEN="$(kubectl get secret agent-secrets -n agent \
  -o jsonpath='{.data.AGENT_INTERNAL_TOKEN}' | base64 -d)"

kubectl port-forward -n agent svc/agent 18001:8001 >/dev/null 2>&1 &
PF_PID=$!
trap 'kill $PF_PID 2>/dev/null || true' EXIT
sleep 3

if [[ "${1:-}" == "short" ]]; then
  USERS=5; RUN_TIME=3m; SPAWN=1; RAMP=""
else
  USERS=200; RUN_TIME=27m; SPAWN=3; RAMP="1"
fi

cd "$REPO_ROOT/loadtest"
# venv создаётся один раз: uv venv .venv --python 3.12 && uv pip install -r requirements.txt --python .venv/bin/python
LOADTEST_RAMP="$RAMP" .venv/bin/locust -f locustfile.py --headless \
  --users "$USERS" --spawn-rate "$SPAWN" --run-time "$RUN_TIME" \
  --csv "$OUT_DIR/$RUN_ID" --only-summary || true

.venv/bin/python report.py "$OUT_DIR/$RUN_ID" \
  --title "Прогон $RUN_ID (до ~10 RPS, пик $USERS виртуальных пользователей)"
