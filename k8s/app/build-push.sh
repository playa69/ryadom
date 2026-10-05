#!/bin/bash
# =============================================================================
# Сборка и push образов сервисов из app/ в Yandex Container Registry
# =============================================================================
# Образы (контекст сборки у всех — каталог app/):
#   cr.yandex/crpsqeamqpuvrkm5tpr9/app/migrate  ← packages/db/Dockerfile
#   cr.yandex/crpsqeamqpuvrkm5tpr9/app/api      ← services/api/Dockerfile (+PWA/OTA)
#   cr.yandex/crpsqeamqpuvrkm5tpr9/app/admin    ← apps/admin/Dockerfile
#   cr.yandex/crpsqeamqpuvrkm5tpr9/app/web      ← apps/web/Dockerfile
#   cr.yandex/crpsqeamqpuvrkm5tpr9/app/landing  ← apps/landing/Dockerfile
#
# Использование (из WSL с docker или из Git Bash с Docker Desktop):
#   bash k8s/app/build-push.sh --login 0.1.0          # логин по ключу + все образы
#   bash k8s/app/build-push.sh 0.1.0 api landing      # только перечисленные
#   bash k8s/app/build-push.sh --no-push 0.1.0        # только собрать в локальный docker,
#                                                     # в реестр НЕ отправлять (проверка Dockerfile'ов)
#
#   --no-push собирает образы под теми же именами cr.yandex/.../app/<name>:<tag> в
#             локальный docker (--load); позже их можно отправить командой
#             `docker push` или повторным запуском без флага (сборка из кэша быстрая).
#
#   --login   docker login в cr.yandex ключом SA ryadom-registry-pusher из
#             registry-pusher-key.json в корне репозитория (в .gitignore).
#             Ключ читается только для передачи в docker login и нигде не
#             печатается. Без флага — считается, что логин уже сделан.
#   <tag>     обязателен; `latest` не используем. Тег должен совпадать с тегом
#             в k8s/app/*/03-deployment.yaml и db/02-job-migrate.yaml (сейчас
#             0.1.0) — при смене версии поправить манифесты.
#
# Платформа linux/amd64 (ноды кластера). --provenance=false --sbom=false:
# docker push образов с attestations падает в YCR на blob upload с "Permission
# denied" (см. k8s/CLOUD-RESOURCES.md); если и так не пушится — собрать
# локально (--load) и `crane copy --platform linux/amd64`.
#
# Build-args образа api вшивают адреса prod в PWA и OTA-бандлы мобильного
# приложения: VITE_PROD_API_URL (app.<домен>) и VITE_PROD_WEB_URL (корень).
# Переопределить: DOMAIN=... bash k8s/app/build-push.sh ...
# =============================================================================

set -euo pipefail

REGISTRY="cr.yandex/crpsqeamqpuvrkm5tpr9/app"
DOMAIN="${DOMAIN:-xn----htbtgjker8b3a2c.xn--p1ai}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTEXT="$REPO_ROOT/app"

DO_LOGIN=0
NO_PUSH=0
while [ "${1:-}" = "--login" ] || [ "${1:-}" = "--no-push" ]; do
  case "$1" in
    --login) DO_LOGIN=1 ;;
    --no-push) NO_PUSH=1 ;;
  esac
  shift
done
[ "$NO_PUSH$DO_LOGIN" != "11" ] || { echo "--login не нужен вместе с --no-push (в реестр ничего не отправляется)" >&2; exit 1; }
if [ "$NO_PUSH" = "1" ]; then OUTPUT_FLAG="--load"; else OUTPUT_FLAG="--push"; fi

TAG="${1:-}"
if [ -z "$TAG" ] || [ "$TAG" = "latest" ]; then
  echo "Использование: bash k8s/app/build-push.sh [--login] <tag> [image ...]" >&2
  echo "Тег обязателен и не может быть latest." >&2
  exit 1
fi
shift

# Какие образы собирать: по умолчанию все
ALL_IMAGES=(migrate api admin web landing)
if [ "$#" -gt 0 ]; then
  IMAGES=("$@")
else
  IMAGES=("${ALL_IMAGES[@]}")
fi

dockerfile_for() {
  case "$1" in
    migrate) echo "packages/db/Dockerfile" ;;
    api)     echo "services/api/Dockerfile" ;;
    admin)   echo "apps/admin/Dockerfile" ;;
    web)     echo "apps/web/Dockerfile" ;;
    landing) echo "apps/landing/Dockerfile" ;;
    *) return 1 ;;
  esac
}

for name in "${IMAGES[@]}"; do
  dockerfile_for "$name" >/dev/null || { echo "Неизвестный образ: $name (доступны: ${ALL_IMAGES[*]})" >&2; exit 1; }
done

if [ "$DO_LOGIN" = "1" ]; then
  KEY_FILE="$REPO_ROOT/registry-pusher-key.json"
  [ -f "$KEY_FILE" ] || { echo "Нет файла $KEY_FILE" >&2; exit 1; }
  docker login --username json_key --password-stdin cr.yandex < "$KEY_FILE"
fi

cd "$CONTEXT"

for name in "${IMAGES[@]}"; do
  image="$REGISTRY/$name:$TAG"
  echo "=== $name → $image ==="
  extra_args=()
  if [ "$name" = "api" ]; then
    extra_args+=(
      --build-arg "VITE_PROD_API_URL=https://app.$DOMAIN"
      --build-arg "VITE_PROD_WEB_URL=https://$DOMAIN"
      --build-arg "OTA_BUILD_NUMBER=${OTA_BUILD_NUMBER:-$(git -C "$REPO_ROOT" rev-list --count HEAD)}"
    )
  fi
  docker buildx build \
    --platform linux/amd64 \
    --provenance=false --sbom=false \
    -f "$(dockerfile_for "$name")" \
    -t "$image" \
    ${extra_args[@]+"${extra_args[@]}"} \
    "$OUTPUT_FLAG" \
    .
done

if [ "$NO_PUSH" = "1" ]; then
  echo "Готово (только локально, в реестр НЕ отправлено): ${IMAGES[*]} → $REGISTRY/*:$TAG"
else
  echo "Готово: ${IMAGES[*]} → $REGISTRY/*:$TAG"
fi
