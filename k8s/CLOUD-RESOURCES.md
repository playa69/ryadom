# Облачные ресурсы проекта Ryadom

Инфраструктура разнесена по двум облакам:

- **Kubernetes-кластер и вычисления** — Timeweb Cloud (`twc-sber500`, k0s v1.36.4,
  3 воркера 2 vCPU / 4–5 ГБ). См. `README.md` раздел про Timeweb.
- **Хранилища, DNS, реестр образов** — Yandex Cloud, фолдер `b1g6o363a3r8n2usnm5u`
  (этот файл).

## Yandex Cloud — что где лежит

### S3 Object Storage (endpoint `https://storage.yandexcloud.net`)

| Бакет | Назначение | Сервисный аккаунт | Ключ |
|---|---|---|---|
| `ryadom-cnpg-backups` | Бэкапы PostgreSQL (CNPG barman: WAL + basebackup, retention 30d) | `ryadom-backups` (storage.editor) | `~/.config/ryadom/s3-backup-key.json` |
| `ryadom-app-storage` | Blobs Langfuse (`langfuse/*`), файлы приложений | `ryadom-app-storage` (storage.editor) | `~/.config/ryadom/s3-app-storage-key.json` |

- Статические ключи — JSON вида `{"access_key": {"key_id": ..., "secret": ...}}`,
  права 600. Из них создаются k8s-секреты (`cnpg-backup-s3-credentials`, `langfuse-s3-credentials`).
- TODO (безопасность): роль `storage.editor` выдана на весь фолдер — перевесить
  на bucket-scoped биндинги.
- ВНИМАНИЕ: в кластере Timeweb PVC на сетевых дисках имеют reclaimPolicy Delete —
  удаление PVC удаляет диск. Бэкапы PG в `ryadom-cnpg-backups` — единственная
  точка восстановления, не чистить.

### Cloud DNS

- Зона `slyshu-ryadom` (id `dnsauuhmqjn8ug3gkhqn`), публичная.
- Домен: `слышу-рядом.рф` (punycode `xn----htbtgjker8b3a2c.xn--p1ai`).
  Делегирован с reg.ru на `ns1.yandexcloud.net` / `ns2.yandexcloud.net`.
- Записи: корневая A → `185.207.64.68` (нода worker-192.168.0.5 кластера Timeweb,
  единая точка входа istio-gateway). Поддоменов нет, routing path-based; сервисы
  из `app/` тоже на корне по путям (`/api`, `/app`, `/admin`; см.
  `README.md`, раздел «Сервисы из app/»), отдельных A-записей не нужно. Для почты
  в этой же зоне: у Postbox (прежний отправитель) — 2 CNAME DKIM, TXT SPF на корне и
  TXT `_dmarc`; у Unisender Go (с 2026-10-11) — дописанный в тот же SPF include, TXT
  подтверждения домена, TXT DKIM `gokey._domainkey` и NS `email` (список и значения —
  `README.md`, «DNS и почта: что сделать руками»).
- Сервисный аккаунт `ryadom-dns` (dns.editor), authorized key —
  `~/.config/ryadom/dns-authorized-key.json`. Создавался под lego DNS-01;
  сейчас сертификаты выпускает cert-manager по HTTP-01, SA оставлен про запас
  (fallback на DNS-01, автоматизация записей).

### Container Registry

- `ryadom-registry` → `cr.yandex/crpsqeamqpuvrkm5tpr9`. С 2026-10-01 —
  **полное зеркало ВСЕХ образов кластера twc-sber500** (docker.io/quay.io/
  ghcr.io/registry.k8s.io/registry.istio.io → cr.yandex): кластер не тянет
  ничего из внешних registry. Схема имён: сохранён путь оригинала без
  registry-хоста, например `istio/pilot:1.30.5` (← registry.istio.io/release/pilot),
  `bitnamilegacy/clickhouse:25.2.1-debian-12-r0`, `library/busybox:1.38.0`.
  Исключение: `bitnami/redis{,-sentinel}:latest` заморожены как `bitnami/redis{,-sentinel}:8.10.2`.
  Архитектура — linux/amd64 (push с Mac arm через `docker pull --platform`).
  Системные образы Timeweb/k0s (kube-system, Calico, CSI addon) НЕ
  зеркалируются — живут на cr-internal.twcstorage.ru и registry.k8s.io.
- Push: SA `ryadom-registry-pusher` (container-registry.images.pusher на
  фолдер), ключ `~/.config/ryadom/registry-pusher-key.json`. Локальный логин:
  `cat registry-pusher-key.json | docker login --username json_key --password-stdin cr.yandex`.
  NB: docker push некоторых образов с attestations (containerd store) падает на
  blob upload с "Permission denied" — обход: `crane copy --platform linux/amd64`
  (crane читает ~/.docker/config.json).
- Pull кластером: SA `ryadom-registry-puller` (container-registry.images.puller
  **на фолдер** — registry-level биндинг через `yc container registry
  add-access-binding` тихо не сохраняется, не использовать), ключ
  `~/.config/ryadom/registry-puller-key.json` → k8s-секрет
  `registry-pull` (dockerconfigjson `json_key:<ключ>`) во всех namespace с
  подами: prod, infra, ryadom-db, monitoring, istio-system, cert-manager,
  cnpg-system. Проброшен в pod spec через values/манифесты (imagePullSecrets).

### Сервисные аккаунты — сводка

| SA | Роли | Статус |
|---|---|---|
| `ryadom-backups` | storage.editor | используется (CNPG) |
| `ryadom-app-storage` | storage.editor | используется (Langfuse) |
| `ryadom-dns` | dns.editor | резерв (DNS-01) |
| `ryadom-registry-pusher` | container-registry.images.pusher (фолдер) | push зеркала + CI |
| `ryadom-registry-puller` | container-registry.images.puller (фолдер) | imagePullSecret registry-pull в кластере |
| `k8s-cluster-208-sa` | k8s.clusters.agent и др. | НЕ используется — кластер YC удалён 2026-10-01, можно удалить |
| `k8s-cluster-208-node-sa` | container-registry.images.puller | НЕ используется — то же |

### Удалённое (история)

- Managed k8s `k8s-cluster-208` + node group + все диски — удалены 2026-10-01,
  кластер переехал на Timeweb. Биллинг за k8s/compute в YC остановлен.

## Локальные файлы с доступами (не в git)

```
~/.config/ryadom/                  # chmod 700, файлы 600
├── s3-backup-key.json             # статический ключ SA ryadom-backups
├── s3-app-storage-key.json        # статический ключ SA ryadom-app-storage
├── dns-authorized-key.json        # authorized key SA ryadom-dns
├── registry-pusher-key.json       # authorized key SA ryadom-registry-pusher
├── registry-puller-key.json       # authorized key SA ryadom-registry-puller
└── k8s-secrets.env                # сгенерированные пароли k8s-секретов (KEY=VALUE)

k8s/twc-sber500-config.yaml        # kubeconfig кластера Timeweb (в .gitignore)
```

`yc` CLI на машине владельца авторизован под его аккаунтом (`yc config list`) —
все операции с ресурсами YC выполняются через него.
