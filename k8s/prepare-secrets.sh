#!/bin/bash
# =============================================================================
# Helper script to generate base64-encoded secrets for Kubernetes
# =============================================================================
# Usage:
#   ./prepare-secrets.sh
#   Then copy-paste base64 values into manifest files.
#   Реальные значения НЕ коммитим в git — файлы с подставленными
#   значениями применяются локально и откатываются, либо секреты
#   создаются напрямую через kubectl (см. postgres/manifests/00-secrets.yaml).
# =============================================================================

set -e

echo "=== Ryadom — Secret Base64 Encoder ==="
echo ""
echo "Введите значения (ввод будет скрыт):"
echo ""

# PostgreSQL Password (роль-владелец ryadom)
echo -n "POSTGRES_PASSWORD (минимум 16 символов, лучше сгенерировать через openssl rand -hex 16): "
read -s POSTGRES_PASSWORD
echo ""
POSTGRES_B64=$(echo -n "$POSTGRES_PASSWORD" | base64)

# PostgreSQL superuser (postgres, для админ-Job'ов)
echo -n "POSTGRES_SUPERUSER_PASSWORD (можно тот же или отдельный): "
read -s SUPERUSER_PASSWORD
echo ""
SUPERUSER_B64=$(echo -n "$SUPERUSER_PASSWORD" | base64)

# Redis (общий, namespace ryadom-db)
echo -n "REDIS_PASSWORD (минимум 16 символов): "
read -s REDIS_PASSWORD
echo ""
REDIS_B64=$(echo -n "$REDIS_PASSWORD" | base64)

# S3 credentials для CNPG backup и Langfuse (Yandex Object Storage)
echo -n "AWS_ACCESS_KEY_ID (статический ключ SA с storage.editor): "
read -s S3_KEY_ID
echo ""
S3_KEY_ID_B64=$(echo -n "$S3_KEY_ID" | base64)

echo -n "AWS_SECRET_ACCESS_KEY: "
read -s S3_SECRET
echo ""
S3_SECRET_B64=$(echo -n "$S3_SECRET" | base64)

# Langfuse: пароли спрашиваем, криптосекреты генерируем сами
echo -n "LANGFUSE_PG_PASSWORD (пароль роли langfuse в PostgreSQL): "
read -s LANGFUSE_PG_PASSWORD
echo ""
LANGFUSE_PG_B64=$(echo -n "$LANGFUSE_PG_PASSWORD" | base64)

echo -n "LANGFUSE_CLICKHOUSE_PASSWORD: "
read -s LANGFUSE_CH_PASSWORD
echo ""
LANGFUSE_CH_B64=$(echo -n "$LANGFUSE_CH_PASSWORD" | base64)

echo -n "LANGFUSE_REDIS_PASSWORD (bundled Redis Langfuse, отдельный от общего): "
read -s LANGFUSE_REDIS_PASSWORD
echo ""
LANGFUSE_REDIS_B64=$(echo -n "$LANGFUSE_REDIS_PASSWORD" | base64)

LANGFUSE_SALT_B64=$(openssl rand -base64 32 | tr -d '\n' | base64)
LANGFUSE_ENCRYPTION_KEY_B64=$(openssl rand -hex 32 | tr -d '\n' | base64)
LANGFUSE_NEXTAUTH_B64=$(openssl rand -base64 32 | tr -d '\n' | base64)

# Yandex authorized key (JSON-файл SA для lego DNS-01, см. tls/TLS-RUNBOOK.md)
echo -n "Путь к authorized-key.json (Enter — пропустить): "
read YC_KEY_PATH
YC_KEY_B64=""
if [ -n "$YC_KEY_PATH" ]; then
  YC_KEY_B64=$(base64 < "$YC_KEY_PATH")
fi

echo ""
echo "=== Скопируйте следующие значения в манифесты ==="
echo ""
echo "--- postgres/manifests/00-secrets.yaml (Secret ryadom-db-credentials) ---"
echo "  password: $POSTGRES_B64"
echo ""
echo "--- postgres/manifests/00-secrets.yaml (Secret ryadom-db-superuser) ---"
echo "  password: $SUPERUSER_B64"
echo ""
echo "--- postgres/manifests/00-secrets.yaml (Secret cnpg-backup-s3-credentials) ---"
echo "  AWS_ACCESS_KEY_ID: $S3_KEY_ID_B64"
echo "  AWS_SECRET_ACCESS_KEY: $S3_SECRET_B64"
echo ""
echo "--- redis/manifests/00-secret.yaml (Secret redis-credentials) ---"
echo "  REDIS_PASSWORD: $REDIS_B64"
echo ""
echo "--- langfuse/manifests/00-secrets.yaml (Secret langfuse-db-credentials, ОБА namespace) ---"
echo "  password: $LANGFUSE_PG_B64"
echo ""
echo "--- langfuse/manifests/00-secrets.yaml (Secret langfuse-clickhouse-credentials) ---"
echo "  password: $LANGFUSE_CH_B64"
echo ""
echo "--- langfuse/manifests/00-secrets.yaml (Secret langfuse-core-secrets) ---"
echo "  SALT: $LANGFUSE_SALT_B64"
echo "  ENCRYPTION_KEY: $LANGFUSE_ENCRYPTION_KEY_B64"
echo "  NEXTAUTH_SECRET: $LANGFUSE_NEXTAUTH_B64"
echo ""
echo "--- langfuse/manifests/00-secrets.yaml (Secret langfuse-s3-credentials) ---"
echo "  S3_ACCESS_KEY_ID: $S3_KEY_ID_B64"
echo "  S3_SECRET_ACCESS_KEY: $S3_SECRET_B64"
echo ""
echo "--- langfuse/manifests/00-secrets.yaml (Secret langfuse-redis-credentials) ---"
echo "  REDIS_PASSWORD: $LANGFUSE_REDIS_B64"
echo ""
if [ -n "$YC_KEY_B64" ]; then
  echo "--- tls/manifests/00-secret-yandex-authorized-key.yaml ---"
  echo "  key: $YC_KEY_B64"
  echo ""
fi
