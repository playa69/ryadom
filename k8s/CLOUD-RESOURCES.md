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
  единая точка входа istio-gateway). Поддоменов нет, routing path-based.
- Сервисный аккаунт `ryadom-dns` (dns.editor), authorized key —
  `~/.config/ryadom/dns-authorized-key.json`. Создавался под lego DNS-01;
  сейчас сертификаты выпускает cert-manager по HTTP-01, SA оставлен про запас
  (fallback на DNS-01, автоматизация записей).

### Container Registry

- `ryadom-registry` → `cr.yandex/crpsqeamqpuvrkm5tpr9` — образы backend/агентов.
- Push: SA `ryadom-registry-pusher` (container-registry.images.pusher) для CI;
  локально — `yc container registry configure-docker` под своим аккаунтом.
- Pull из кластера Timeweb: нужен imagePullSecret `registry-pull`
  (dockerconfigjson с IAM-токеном или ключом SA) в каждом namespace,
  где крутятся поды с образами из реестра.

### Сервисные аккаунты — сводка

| SA | Роли | Статус |
|---|---|---|
| `ryadom-backups` | storage.editor | используется (CNPG) |
| `ryadom-app-storage` | storage.editor | используется (Langfuse) |
| `ryadom-dns` | dns.editor | резерв (DNS-01) |
| `ryadom-registry-pusher` | container-registry.images.pusher | CI |
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
└── k8s-secrets.env                # сгенерированные пароли k8s-секретов (KEY=VALUE)

k8s/twc-sber500-config.yaml        # kubeconfig кластера Timeweb (в .gitignore)
```

`yc` CLI на машине владельца авторизован под его аккаунтом (`yc config list`) —
все операции с ресурсами YC выполняются через него.
