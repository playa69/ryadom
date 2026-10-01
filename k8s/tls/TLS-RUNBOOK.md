# TLS для ryadom — lego DNS-01 (Yandex Cloud DNS)

> Подход скопирован с референсного проекта (`UnionApp/k8s/sevenelement/TLS-RUNBOOK.md`,
> дата решения 2026-07-23): cert-manager http01 с Istio не используется
> (solver'у нужен вход через ingress, а вход — это Istio Gateway, которому уже
> нужен сертификат; сторонние webhook-solver'ы запрещены решением владельца).
> Вместо этого — официальный ACME-клиент **lego** (`goacme/lego`, нативный
> провайдер `yandexcloud`), DNS-01 через TXT `_acme-challenge` в Yandex Cloud DNS.

## Как это работает

- Выпуск/продление — официальный образ `goacme/lego` (без сторонних чартов
  в кластере), DNS-01 challenge через провайдер `yandexcloud`.
- DNS-зона `<CHANGE_ME_DOMAIN>.` должна быть создана в Yandex Cloud DNS
  (`yc dns zone create`), folder — `<CHANGE_ME_DNS_FOLDER_ID>`.
- Доступ к DNS API: сервисный аккаунт с ролью `dns.editor` на folder с зоной.
  Authorized key (JSON) лежит в k8s-секрете `infra/yandex-authorized-key`
  (ключ `key`) — шаблон `manifests/00-secret-yandex-authorized-key.yaml`,
  реальное значение в git НЕ коммитим.
- Выпущенный сертификат (Let's Encrypt prod, 90 дней) кладётся в секрет
  `ryadom-tls` — его использует Istio Gateway (`credentialName: ryadom-tls`).
- **ВАЖНО (урок референса, 2026-07-23):** istiod резолвит `credentialName`
  в namespace gateway-WORKLOAD (`istio-system`), а не в namespace
  Gateway-ресурса. Поэтому секрет обязательно создаётся в `istio-system`;
  рекомендуется держать копию и в ns приложения (`prod`). При продлении
  обновлять секрет **в обоих namespace**.

## Выпуск / продление (за 30+ дней до истечения)

```bash
# 1. Ключ SA для DNS API (уже лежит в секрете кластера)
B64KEY=$(kubectl -n infra get secret yandex-authorized-key -o jsonpath='{.data.key}')

# 2. Выпуск/продление (lego сам решит — run или renew)
docker run --rm --platform linux/amd64 -v lego-certs-prod:/certs \
  -e YANDEX_CLOUD_IAM_TOKEN="$B64KEY" \
  -e YANDEX_CLOUD_FOLDER_ID=<CHANGE_ME_DNS_FOLDER_ID> \
  goacme/lego:latest run \
  --server https://acme-v02.api.letsencrypt.org/directory \
  --email <CHANGE_ME_EMAIL> --dns yandexcloud \
  -d <CHANGE_ME_DOMAIN> --path /certs --accept-tos

# 3. Вытащить сертификат и обновить секрет
docker run --rm --platform linux/amd64 -v lego-certs-prod:/certs \
  busybox cat /certs/certificates/<CHANGE_ME_DOMAIN>.crt > /tmp/ryadom.crt
docker run --rm --platform linux/amd64 -v lego-certs-prod:/certs \
  busybox cat /certs/certificates/<CHANGE_ME_DOMAIN>.key > /tmp/ryadom.key
chmod 600 /tmp/ryadom.key
openssl x509 -in /tmp/ryadom.crt -noout -issuer -dates   # проверка: LE prod, не staging

# обязательная копия для ingressgateway SDS (см. «ВАЖНО» выше)
kubectl -n istio-system create secret tls ryadom-tls \
  --cert=/tmp/ryadom.crt --key=/tmp/ryadom.key --dry-run=client -o yaml | \
  kubectl apply -f -
# копия в ns приложения (Gateway-ресурс живёт там)
kubectl -n prod create secret tls ryadom-tls \
  --cert=/tmp/ryadom.crt --key=/tmp/ryadom.key --dry-run=client -o yaml | \
  kubectl apply -f -
rm -f /tmp/ryadom.crt /tmp/ryadom.key
```

Проверка issuer: `issuer=... O=Let's Encrypt ...` (не `STAGING`).

## TODO

- [ ] Автопродление: CronJob в кластере (свой образ lego+kubectl, SA с правом
      update только на secret `ryadom-tls` в `istio-system` и `prod`) — до
      первого истечения сертификата. В референсе на 2026-09 тоже в TODO:
      продление выполняется вручную по этому runbook'у.
