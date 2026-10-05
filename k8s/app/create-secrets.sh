#!/bin/bash
# =============================================================================
# Секреты сервисов из app/: локальный .env-файл → секреты в кластере
# =============================================================================
# ПРАВИЛО: в файле и в Secret'ах — ТОЛЬКО секреты. Статические несекретные
# значения (хост/порт/имя БД и пользователь, список админов, адреса, флаги) лежат
# в ConfigMap'ах в git: k8s/app/00-app-config.yaml и k8s/app/admin/00-config.yaml.
#
# ИСТОЧНИК СЕКРЕТОВ — локальный файл app-secrets.env в КОРНЕ репозитория (другой
# путь — переменная RYADOM_SECRETS_FILE). Ключи файла:
#   DB_PASSWORD         пароль роли app в PostgreSQL
#   AUTH_SECRET         подпись сессий веб-клиента и админки (≥32 символов)
#   MOBILE_JWT_SECRET   подпись токенов мобильного клиента (≥32 символов)
#   AGENT_API_TOKEN     токен агента (пусто, пока агента нет)
#   SMTP_PASSWORD       пароль SMTP (пусто, пока почта не подключена)
# Файл создаётся один раз командой
#   bash k8s/app/create-secrets.sh --generate-only     # без кластера и без kubectl
# (недостающие значения генерируются через openssl), затем обычный запуск создаёт
# секреты в кластере ИЗ ЭТОГО ФАЙЛА. Недостающее допишется в файл ДО создания
# секретов в кластере: если записать не удалось, в кластере ничего не создаётся.
# Повторный запуск после сбоя берёт значения из файла, а не генерирует заново.
#
# Создаёт в кластере (kubectl create — НЕ apply: если секрет уже есть, скрипт
# останавливается, а не перезаписывает пароли):
#   ryadom-db / app-db-credentials   password                       ← читает Job create-app-db
#   prod      / app-secrets          DB_PASSWORD, AUTH_SECRET, MOBILE_JWT_SECRET,
#                                    REDIS_PASSWORD (копия ryadom-db/redis-credentials,
#                                    в файл не пишется), AGENT_API_TOKEN
#   prod      / app-smtp             SMTP_PASSWORD — только если задан
#
# Файл НЕ должен попасть в git: скрипт отказывается работать, пока git его не
# игнорирует (git check-ignore). .gitignore не меняем — файл скрывается локально:
#   echo /app-secrets.env >> .git/info/exclude
#   echo '/.app-secrets.*' >> .git/info/exclude      # временные файлы записи
# (в новом клоне это нужно повторить; скрипт подскажет).
#
# Это единственная копия вне кластера: потеряете её вместе с кластером — все сессии
# пользователей станут недействительны (AUTH_SECRET). Положите копию в менеджер
# паролей. Права файла 0600 обеспечиваются на обычной файловой системе; на /mnt/c в
# WSL и в Windows chmod не действует — не храните репозиторий в синхронизируемой папке.
#
# Использование (kubeconfig админский — доступ к ns ryadom-db и prod):
#   bash k8s/app/create-secrets.sh --generate-only  # 1) только файл, кластер не трогаем
#   export KUBECONFIG=~/.kube/ryadom-admin.yaml
#   bash k8s/app/create-secrets.sh                  # 2) секреты в кластер из файла
#   bash k8s/app/create-secrets.sh --yes            #    без вопроса про контекст
#   SMTP_PASSWORD=... bash k8s/app/create-secrets.sh --smtp-only   # позже: почта
# SMTP_PASSWORD и AGENT_API_TOKEN можно передать переменной окружения (попадёт в
# файл). Остальное про почту (SMTP_HOST/PORT/SECURE/USER, EMAIL_TRANSPORT=smtp) —
# несекретное, в k8s/app/00-app-config.yaml.
#
# Вход в админку — по коду из письма. Пока EMAIL_TRANSPORT=console (см.
# 00-app-config.yaml), письма не уходят, а пишутся в лог пода:
#   kubectl -n prod logs deploy/app-admin | grep -i "console transport"
# =============================================================================

set -euo pipefail

command -v openssl >/dev/null || { echo "openssl не найден в PATH" >&2; exit 1; }

ASSUME_YES=0
SMTP_ONLY=0
GENERATE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --smtp-only) SMTP_ONLY=1 ;;
    --generate-only) GENERATE_ONLY=1 ;;
    *) echo "Неизвестный аргумент: $arg" >&2; exit 1 ;;
  esac
done
[ "$GENERATE_ONLY$SMTP_ONLY" != "11" ] || { echo "--generate-only и --smtp-only несовместимы" >&2; exit 1; }
[ "$GENERATE_ONLY" = "1" ] || command -v kubectl >/dev/null || { echo "kubectl не найден в PATH" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SECRETS_FILE="${RYADOM_SECRETS_FILE:-$REPO_ROOT/app-secrets.env}"

# Файл с секретами внутри git-репозитория обязан игнорироваться git — иначе его
# легко закоммитить. Если файл вне репозитория, проверка не нужна.
ensure_git_ignored() {
  local dir
  dir="$(dirname "$SECRETS_FILE")"
  [ -d "$dir" ] || return 0
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if ! git -C "$dir" check-ignore -q -- "$SECRETS_FILE"; then
      echo "ОТКАЗ: $SECRETS_FILE лежит в git-репозитории и не игнорируется git." >&2
      echo "Скройте его локально (без правки .gitignore) и запустите снова:" >&2
      echo "  echo '/$(basename "$SECRETS_FILE")' >> \"\$(git -C '$dir' rev-parse --git-path info/exclude)\"" >&2
      echo "  echo '/.app-secrets.*' >> \"\$(git -C '$dir' rev-parse --git-path info/exclude)\"" >&2
      exit 1
    fi
  fi
}
ensure_git_ignored

# Временные файлы (значения секретов) удаляются при любом выходе
ENV_FILE="$(umask 077; mktemp)"
TMP_SAVE=""
trap 'rm -f "$ENV_FILE" "${TMP_SAVE:-}"' EXIT

exists() { kubectl -n "$1" get secret "$2" >/dev/null 2>&1; }

# Значение ключа из существующего секрета кластера (пусто, если нет)
cluster_value() {
  kubectl -n "$1" get secret "$2" -o "jsonpath={.data.$3}" 2>/dev/null | base64 -d || true
}

# Значение из ранее сохранённого файла (файл написан этим же скриптом через %q,
# поэтому его можно безопасно прочитать в подоболочке)
saved() {
  [ -f "$SECRETS_FILE" ] || return 0
  ( set +u; . "$SECRETS_FILE"; eval "printf '%s' \"\${$1-}\"" )
}

# Пишет файл целиком (атомарно, 0600). Каталог создаётся с 0700, а у уже
# существующего (например, корня репозитория) права НЕ трогаем.
save_file() {
  local dir
  dir="$(dirname "$SECRETS_FILE")"
  [ -d "$dir" ] || ( umask 077; mkdir -p "$dir" )
  TMP_SAVE="$(umask 077; mktemp "$dir/.app-secrets.XXXXXX")"
  {
    echo "# Секреты сервисов из app/ (создано k8s/app/create-secrets.sh, $(date -u +%Y-%m-%dT%H:%M:%SZ))"
    echo "# ТОЛЬКО секреты; статические значения — в ConfigMap (k8s/app/*.yaml)."
    echo "# НЕ коммитить. Источник для деплоя; резервную копию держите в менеджере паролей."
    for key in DB_PASSWORD AUTH_SECRET MOBILE_JWT_SECRET AGENT_API_TOKEN SMTP_PASSWORD; do
      printf '%s=%q\n' "$key" "${!key-}"
    done
  } > "$TMP_SAVE"
  chmod 600 "$TMP_SAVE" 2>/dev/null || true
  mv "$TMP_SAVE" "$SECRETS_FILE"
  TMP_SAVE=""
  # Честно сообщаем о реальных правах: на NTFS и /mnt/c chmod ничего не делает
  local perm
  perm="$(stat -c '%a' "$SECRETS_FILE" 2>/dev/null || echo '?')"
  if [ "$perm" != "600" ]; then
    echo "ВНИМАНИЕ: права файла $SECRETS_FILE — $perm, а не 600 (файловая система не поддерживает chmod)." >&2
    echo "          Не публикуйте и не синхронизируйте этот файл; он вне git, но читаем всеми локальными пользователями." >&2
  fi
}

# Значения: из файла, иначе из переменной окружения, иначе генерируем
DB_PASSWORD="$(saved DB_PASSWORD)"
AUTH_SECRET="$(saved AUTH_SECRET)"
MOBILE_JWT_SECRET="$(saved MOBILE_JWT_SECRET)"
AGENT_API_TOKEN="${AGENT_API_TOKEN:-$(saved AGENT_API_TOKEN)}"
SMTP_PASSWORD="${SMTP_PASSWORD:-$(saved SMTP_PASSWORD)}"
[ -n "$DB_PASSWORD" ] || DB_PASSWORD="$(openssl rand -hex 24)"
[ -n "$AUTH_SECRET" ] || AUTH_SECRET="$(openssl rand -hex 32)"
[ -n "$MOBILE_JWT_SECRET" ] || MOBILE_JWT_SECRET="$(openssl rand -hex 32)"
[ -f "$SECRETS_FILE" ] && echo "Использую значения из $SECRETS_FILE" || true

# --- Режим «только сгенерировать»: файл есть, кластер не трогаем ---
if [ "$GENERATE_ONLY" = "1" ]; then
  save_file
  echo "Готово: $SECRETS_FILE (значения не показываю)."
  echo "Ключи в файле: DB_PASSWORD, AUTH_SECRET, MOBILE_JWT_SECRET, AGENT_API_TOKEN, SMTP_PASSWORD"
  echo "Дальше: export KUBECONFIG=...; bash k8s/app/create-secrets.sh"
  exit 0
fi

# Показываем, в какой кластер пойдёт запись, и просим подтвердить
echo "kubectl context: $(kubectl config current-context)"
echo "API server:      $(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
if [ "$ASSUME_YES" != "1" ]; then
  read -r -p "Создать секреты в этом кластере? [y/N] " answer
  [ "$answer" = "y" ] || { echo "Отмена."; exit 1; }
fi

create_smtp() {
  [ -n "${SMTP_PASSWORD:-}" ] || return 0
  if exists prod app-smtp; then
    echo "prod/app-smtp уже существует — пропуск" >&2
    return 0
  fi
  printf 'SMTP_PASSWORD=%s\n' "$SMTP_PASSWORD" > "$ENV_FILE"
  kubectl -n prod create secret generic app-smtp --from-env-file="$ENV_FILE"
}

# --- Режим «только SMTP»: почту подключают позже, остальные секреты уже есть ---
if [ "$SMTP_ONLY" = "1" ]; then
  [ -n "${SMTP_PASSWORD:-}" ] || { echo "Нужен SMTP_PASSWORD" >&2; exit 1; }
  exists prod app-smtp && { echo "prod/app-smtp уже существует — остановка" >&2; exit 1; }
  # Локальный файл должен совпадать с кластером. Если секреты уже созданы, а в
  # файле их нет (другая машина, файл потерян), берём значения из кластера, а не
  # сгенерированные выше «с нуля».
  if exists prod app-secrets; then
    [ -n "$(saved DB_PASSWORD)" ] || DB_PASSWORD="$(cluster_value prod app-secrets DB_PASSWORD)"
    [ -n "$(saved AUTH_SECRET)" ] || AUTH_SECRET="$(cluster_value prod app-secrets AUTH_SECRET)"
    [ -n "$(saved MOBILE_JWT_SECRET)" ] || MOBILE_JWT_SECRET="$(cluster_value prod app-secrets MOBILE_JWT_SECRET)"
  fi
  # Сначала сохраняем, потом создаём в кластере
  save_file
  create_smtp
  echo "Готово: prod/app-smtp создан, значения сохранены в $SECRETS_FILE"
  echo "Дальше: SMTP_HOST/PORT/SECURE/USER и EMAIL_TRANSPORT=smtp в k8s/app/00-app-config.yaml,"
  echo "правило egress в NetworkPolicy, затем перезапуск api/admin."
  exit 0
fi

# Ничего не перезаписываем: если секрет уже есть — стоп
exists ryadom-db app-db-credentials && { echo "ryadom-db/app-db-credentials уже существует — остановка" >&2; exit 1; }
exists prod app-secrets && { echo "prod/app-secrets уже существует — остановка" >&2; exit 1; }

# Предусловия кластера
kubectl -n ryadom-db get secret ryadom-db-superuser >/dev/null || { echo "Нет ryadom-db/ryadom-db-superuser" >&2; exit 1; }
kubectl -n prod get secret registry-pull >/dev/null || { echo "Нет prod/registry-pull (pull-секрет реестра)" >&2; exit 1; }
REDIS_PASSWORD="$(kubectl -n ryadom-db get secret redis-credentials -o jsonpath='{.data.REDIS_PASSWORD}' | base64 -d)"
[ -n "$REDIS_PASSWORD" ] || { echo "Пустой REDIS_PASSWORD в ryadom-db/redis-credentials" >&2; exit 1; }

# СНАЧАЛА сохраняем файл: если не вышло — в кластере ничего не создаём
save_file
echo "Файл с секретами обновлён: $SECRETS_FILE"

# Значения передаём через временный env-файл (0600), а не через аргументы
# командной строки — чтобы они не светились в списке процессов.

# 1. Пароль роли app для Job create-app-db (ns ryadom-db)
printf 'password=%s\n' "$DB_PASSWORD" > "$ENV_FILE"
kubectl -n ryadom-db create secret generic app-db-credentials --from-env-file="$ENV_FILE"

# 2. Секреты приложений (ns prod). DATABASE_URL здесь НЕТ: он собирается в
#    манифестах из ConfigMap (хост, порт, база, пользователь) и DB_PASSWORD.
{
  printf 'DB_PASSWORD=%s\n' "$DB_PASSWORD"
  printf 'AUTH_SECRET=%s\n' "$AUTH_SECRET"
  printf 'MOBILE_JWT_SECRET=%s\n' "$MOBILE_JWT_SECRET"
  printf 'REDIS_PASSWORD=%s\n' "$REDIS_PASSWORD"
  printf 'AGENT_API_TOKEN=%s\n' "$AGENT_API_TOKEN"
} > "$ENV_FILE"
kubectl -n prod create secret generic app-secrets --from-env-file="$ENV_FILE"

# 3. SMTP — только если задан пароль
create_smtp

echo "Готово. Секреты созданы из $SECRETS_FILE."
echo "Дальше: kubectl apply -f k8s/app/db/01-job-create-db.yaml"
