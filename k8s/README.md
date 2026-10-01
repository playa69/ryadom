# Ryadom — Kubernetes (Timeweb Cloud)

Kubernetes-манифесты проекта Ryadom. Рабочий кластер — **Timeweb Cloud**,
managed k8s `twc-sber500` (k0s v1.36.4, Calico enforced, регион Москва),
3 воркера 2 vCPU / 4–5 ГБ. kubeconfig — `k8s/twc-sber500-config.yaml`
(в .gitignore, НЕ коммитить).

Часть инфраструктуры живёт в Yandex Cloud: S3-бакеты (бэкапы PG, blobs
Langfuse), Cloud DNS (зона слышу-рядом.рф), Container Registry — инвентарь
и доступы в `CLOUD-RESOURCES.md`. Изначальный кластер в Yandex Cloud
(k8s-cluster-208) удалён 2026-10-01, биллинг остановлен.

Namespaces: `prod` (istio-injection), `infra`, `ryadom-db` (без injection —
там CNPG и Redis). Только production, dev/stage не нужны — при появлении
добавить по образцу prod.

## Структура

```
k8s/
├── README.md                       ← этот файл
├── CLOUD-RESOURCES.md              ← инвентарь YC: S3, DNS, registry, SA, ключи
├── prepare-secrets.sh              ← генератор base64 для секретов
├── twc-sber500-config.yaml         ← kubeconfig (в .gitignore!)
├── namespaces/manifests/
│   ├── 00-namespaces.yaml          ← prod (+istio-injection), infra, ryadom-db
│   ├── 01-network-policy-prod.yaml    ← + egress в ryadom-db:5432/6379
│   ├── 02-network-policy-infra.yaml   ← + egress в ryadom-db:5432/6379
│   ├── 03-network-policy-ryadom-db.yaml
│   └── 04-network-policy-kube-apiserver.yaml  ← egress на 192.168.0.4:6443 (урок post-DNAT)
├── istio/
│   ├── values-istiod.yaml          ← helm values control plane
│   ├── values-ingressgateway.yaml  ← helm values gateway (DaemonSet + hostPort)
│   └── manifests/
│       ├── 00-example-gateway.yaml ← ШАБЛОН HTTPRoute (path-based)
│       └── 01-gateway-api-gateway.yaml  ← Gateway ryadom-gateway (manual, GW API)
├── cert-manager/manifests/
│   ├── 00-cluster-issuer.yaml      ← letsencrypt-prod, solver gatewayHTTPRoute
│   └── 01-certificate-ryadom-tls.yaml   ← cert на корневой домен → istio-system
├── tls/                            ← РЕЗЕРВ: lego DNS-01 runbook (не используется,
│                                     рабочая схема — cert-manager HTTP-01)
├── postgres/manifests/
│   ├── 00-secrets.yaml             ← ШАБЛОН, реальные значения не коммитим
│   ├── 01-cnpg-cluster.yaml        ← CNPG ryadom-db, 2 инстанса, NVMe, backup→S3
│   ├── 02-cnpg-backup.yaml         ← ScheduledBackup (daily → S3)
│   └── 03-network-policy.yaml      ← ingress к подам PG
├── redis/manifests/
│   ├── 00-secret.yaml              ← ШАБЛОН redis-credentials
│   ├── 01-redis-statefulset.yaml   ← Redis 7.4, 1 реплика, PVC 5Gi NVMe
│   ├── 02-redis-service.yaml       ← ClusterIP :6379
│   └── 03-network-policy.yaml      ← :6379 от prod и infra
└── langfuse/
    ├── values-langfuse.yaml        ← helm values (PG=CNPG, CH 1 реплика, свой Redis, S3)
    └── manifests/
        ├── 00-secrets.yaml         ← ШАБЛОНЫ секретов Langfuse (+ копия в ryadom-db)
        ├── 01-job-create-db.yaml   ← Job: роль+база langfuse в CNPG
        └── 02-gateway.yaml         ← ШАБЛОН HTTPRoute /langfuse на будущее, НЕ применять
```

## Кластер twc-sber500

- API: endpoint из kubeconfig; control plane отдельно (192.168.0.4:6443 —
  см. урок про NetworkPolicy ниже).
- Ноды: worker-192.168.0.5/6/7, external IP 185.207.64.68, 37.252.20.221,
  37.252.20.94. Нода .5 увеличена до 5 ГБ RAM.
- CNI: Calico (NetworkPolicy enforced из коробки), CoreDNS, metrics-server.
- Кластер создан через панель Timeweb; CSI-driver — через «Дополнения».

## Хранилище: сетевые диски Timeweb (CSI)

CSI-драйвер `network-drives.csi.timeweb.cloud` — установка через панель
(«Дополнения» → CSI-driver) или Helm (OCI-чарт
`oci://cr-internal.twcstorage.ru/network-drives-csi/csi-driver-timeweb-cloud`,
нужны API-токен и cluster ID). StorageClass'ы:

- `nvme.network-drives.csi.timeweb.cloud` — **default**, все PVC на нём
  (WaitForFirstConsumer, expansion: true)
- `hdd.network-drives.csi.timeweb.cloud` — класс существует, но в Москве
  недоступен: CreateVolume "disk preset not found" (проверено тестовым PVC)
- local-path-provisioner оставлен в кластере как запасной, без default

**ВАЖНО: reclaimPolicy Delete — удаление PVC удаляет сетевой диск в панели
вместе с данными.** Для PG допустимо (бэкапы в S3), для ручных данных —
создавать диск в панели и подключать через PV с Retain.

## Вход в кластер: единая точка входа

LoadBalancer в Timeweb managed k8s нет. Схема:

- istio-ingressgateway — DaemonSet, порты 80/443 через hostPort
  (portmap в k0s/Calico). hostNetwork НЕ используется: istiod пропускает
  инъекцию для hostNetwork-подов (image "auto", под не стартует), а
  pod-sysctl чарта несовместим с hostNetwork. Патч после каждого helm
  upgrade — команды в шапке `istio/values-ingressgateway.yaml`.
- **Точка входа одна**: A-запись корневого домена → только 185.207.64.68
  (worker-192.168.0.5). DNS round-robin по нодам отключён сознательно —
  маршрутизацией управляет Istio внутри кластера, а не клиент.
  Gateway закреплён за нодой .5 nodeAffinity-патчем DaemonSet (1 под;
  на .6/.7 подов нет, 80/443 там не слушаются). Патч слетает при helm
  upgrade — команда в шапке `istio/values-ingressgateway.yaml`.
- **Отказ ноды .5** = сайт лежит до ручного возврата: снять nodeAffinity
  (поды встанут на .6/.7) и переключить A-запись на 37.252.20.221 или
  37.252.20.94 (TTL 300 — ~5 мин). При переходе на Timeweb LB (платный)
  эта схема заменяется на LB → NodePort.

## Домен и TLS

Домен: **слышу-рядом.рф** (`xn----htbtgjker8b3a2c.xn--p1ai`), делегирован
с reg.ru на Yandex Cloud DNS (зона `slyshu-ryadom`, см. CLOUD-RESOURCES.md).
Только корневой домен, поддоменов нет, wildcard удалён — маршрутизация
path-based через HTTPRoute (шаблон `istio/manifests/00-example-gateway.yaml`).

TLS — cert-manager + Gateway API:

1. Gateway API CRDs: `kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.0/standard-install.yaml`
2. cert-manager: `helm install cert-manager jetstack/cert-manager -n cert-manager
   --create-namespace --version v1.21.2 --set crds.enabled=true
   --set extraArgs='{--enable-gateway-api}'`
3. ClusterIssuer letsencrypt-prod — `cert-manager/manifests/00-cluster-issuer.yaml`
   (solver `gatewayHTTPRoute` — в cert-manager ≥1.16 переименован из
   gatewayHTTP01; parentRef на Gateway ryadom-gateway)
4. Certificate `ryadom-tls` — `cert-manager/manifests/01-certificate-ryadom-tls.yaml`:
   dnsNames = только корень, секрет в istio-system. Выпуск ~1 мин:
   solver-HTTPRoute на /.well-known/acme-challenge/* цепляется к listener :80.
5. Gateway — `istio/manifests/01-gateway-api-gateway.yaml`: listener :80
   (ACME + редирект 301→https) и :443 (certificateRef ryadom-tls).

Резервная схема (lego DNS-01 через Yandex Cloud DNS) — `tls/TLS-RUNBOOK.md`,
сейчас не используется.

## Порядок применения

### 0. Секреты (заполнить заранее, НЕ коммитить)

```bash
export KUBECONFIG=~/PycharmProjects/ryadom/k8s/twc-sber500-config.yaml
cd k8s && ./prepare-secrets.sh   # base64 для подстановки; справка — ~/.config/ryadom/k8s-secrets.env
```

| Секрет | Namespace | Ключи |
|---|---|---|
| `ryadom-db-credentials` | ryadom-db | `username`, `password` (роль-владелец `ryadom`) |
| `ryadom-db-superuser` | ryadom-db | `username` (`postgres`), `password` |
| `cnpg-backup-s3-credentials` | ryadom-db | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| `redis-credentials` | ryadom-db | `REDIS_PASSWORD` |
| `langfuse-db-credentials` | infra **и** ryadom-db (копия для Job) | `username`, `password` |
| `langfuse-clickhouse-credentials` | infra | `password` |
| `langfuse-core-secrets` | infra | `SALT`, `ENCRYPTION_KEY`, `NEXTAUTH_SECRET` |
| `langfuse-s3-credentials` | infra | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| `langfuse-redis-credentials` | infra | `REDIS_PASSWORD` (bundled Redis Langfuse) |

S3-ключи и пароли — в `~/.config/ryadom/` (см. CLOUD-RESOURCES.md).

### 1. Namespaces → NetworkPolicy → Istio → TLS → CNPG → PostgreSQL → Redis → Langfuse

```bash
kubectl apply -f namespaces/manifests/   # 00-04, включая 04 (apiserver egress)

helm repo add istio https://istio-release.storage.googleapis.com/charts
helm install istio-base istio/base -n istio-system --create-namespace
helm install istiod istio/istiod -n istio-system -f istio/values-istiod.yaml
helm install istio-ingressgateway istio/gateway -n istio-system \
  -f istio/values-ingressgateway.yaml
# патч DaemonSet на hostPort — см. шапку values-ingressgateway.yaml

# TLS: GW API CRDs + cert-manager + манифесты cert-manager/ (см. раздел выше)

helm repo add cnpg https://cloudnative-pg.github.io/charts
helm install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace

kubectl apply -f postgres/manifests/     # секреты предварительно создать!
kubectl get cluster ryadom-db -n ryadom-db    # дождаться healthy 2/2
kubectl get backups -n ryadom-db              # initial backup completed

kubectl apply -f redis/manifests/
kubectl exec -n ryadom-db redis-0 -- sh -c \
  'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping'   # → PONG

kubectl apply -f langfuse/manifests/00-secrets.yaml
kubectl apply -f langfuse/manifests/01-job-create-db.yaml
helm install langfuse langfuse/langfuse -n infra \
  -f langfuse/values-langfuse.yaml --version 1.5.41
```

## Доступы: кластер и облако

### Доступ людей/CI к кластеру (kubectl)

Сейчас существует только **админский kubeconfig** `twc-sber500-config.yaml`
(cluster-admin из панели Timeweb). Отдельных ServiceAccount с RBAC для
разработчиков/CI пока нет. Создавать по паттерну стенда
(`~/PycharmProjects/k8s/make-developer-kubeconfig.sh`): SA + Role/ClusterRole
+ долгоживущий токен (Secret типа `kubernetes.io/service-account-token`) +
генерация ограниченного kubeconfig. TODO: завести `developer` (read-only +
port-forward) и `ci-deploy` (write в prod/infra) до подключения CI.

### ServiceAccount внутри кластера (рабочие)

| SA | Namespace | Кто использует |
|---|---|---|
| `istiod`, `istio-ingressgateway`, `istio-reader-service-account` | istio-system | control plane, gateway |
| `ryadom-db` | ryadom-db | инстансы CNPG (ходят в K8s API — см. 04-network-policy) |
| `db-jobs` | ryadom-db | админ-Job'ы (create-langfuse-db) |
| `redis` | ryadom-db | Redis-под (`automountServiceAccountToken: false`) |
| `langfuse`, `langfuse-clickhouse`, `langfuse-redis-primary` | infra | чарт Langfuse |

### Доступ к Yandex Cloud из кластера (через Secrets)

| Secret | Namespace | Что внутри | SA в YC |
|---|---|---|---|
| `cnpg-backup-s3-credentials` | ryadom-db | статический S3-ключ (бэкапы → ryadom-cnpg-backups) | `ryadom-backups` |
| `langfuse-s3-credentials` | infra | статический S3-ключ (blobs → ryadom-app-storage) | `ryadom-app-storage` |
| `registry-pull` | prod (TODO) | dockerconfigjson для pull из cr.yandex/crpsqeamqpuvrkm5tpr9 — создать при первом деплое приложения (ключ SA `ryadom-registry-pusher` ещё не выпускался) | `ryadom-registry-pusher` |
| `ryadom-tls` | istio-system | LE-сертификат корневого домена (создаёт cert-manager); копия в prod — при публикации Gateway из prod | — |

Ключ SA `ryadom-dns` (dns.editor) в кластер НЕ загружался — HTTP-01 его не
требует; нужен только для резервной схемы DNS-01 (tls/TLS-RUNBOOK.md,
шаблон `tls/manifests/00-secret-yandex-authorized-key.yaml`).

## Модель NetworkPolicy

Default-deny ingress+egress в каждом namespace; разрешены: ingress от
istio-ingressgateway, pod-to-pod внутри namespace, DNS (kube-system :53),
HTTPS наружу (:443 — LLM API, S3), egress на kube-apiserver
(04-network-policy-kube-apiserver.yaml), для meshed ns — сайдкары → istiod
(:15012/:15010). Меж-namespace только явные prod/infra → ryadom-db:5432/6379.

**Урок (Calico post-DNAT):** egress-политика применяется ПОСЛЕ DNAT
kube-proxy: обращение к kubernetes.default 10.96.0.1:443 превращается в
192.168.0.4:6443, и правило «:443 наружу» его НЕ покрывает — поды CNPG
(initdb/join) не достукиваются до API, bootstrap висит. Лечение — явный
egress из `04-…yaml`. Актуальный endpoint: `kubectl get endpoints kubernetes`.

**TODO по ужесточению:** сузить egress 0.0.0.0/0:443 до CIDR LLM-провайдеров;
REGISTRY_ONLY + ServiceEntry-allowlist + AuthorizationPolicy-матрица —
после появления приложений (паттерн UnionApp/k8s/cluster-policies/istio-isolation/).

## Langfuse: internal-only

Публично НЕ публикуется: base path в Langfuse v3 зашит в статику web-образа
на этапе сборки (NEXT_PUBLIC_BASE_PATH — build-arg, prebuilt-образ не
подходит, см. langfuse.com/self-hosting/configuration/custom-base-path).
Доступ: `kubectl port-forward -n infra svc/langfuse-web 3000:3000` →
http://localhost:3000. Публичный вход — только под будущее API.
`langfuse/manifests/02-gateway.yaml` — шаблон на будущее (после пересборки
web-образа с base path), НЕ применять.

Чарт пиннется `--version 1.5.41` (линейка 1.5.x = Langfuse v3 + Bitnami
subchart'ы; чарт 2.x = Langfuse v4 + valkey-io subchart с несовместимой
схемой values — миграция отдельной задачей).

## PostgreSQL: нюансы

- Backup-префикс: `s3://ryadom-cnpg-backups/cnpg-backups/ryadom-db-twc`
  (barman-cloud-check-wal-archive требует пустой архив; под
  `.../ryadom-db` остались объекты удалённого YC-кластера — не трогать).
- Инстансов 2 (ноды 4–5 ГБ), не 3. Anti-affinity CNPG раскидывает по нодам.
- Известный сюжет: роль postgres при bootstrap получила пароль не из
  секрета (initdb падал из-за NP на apiserver) — выровнено вручную
  `ALTER ROLE postgres WITH PASSWORD`. Симптом: Job create-langfuse-db —
  "password authentication failed for user postgres".

## Откат

- Helm: `helm history <release> -n <ns>` → `helm rollback`.
- Манифесты: предыдущая версия в Git, `kubectl apply` старой версии.
- PostgreSQL: восстановление из continuous backup (barman-cloud, S3),
  см. документацию CNPG по recovery. PVC НЕ удалять — reclaimPolicy Delete
  убивает сетевой диск.

## Статус установки (2026-10-01)

| Компонент | Версия | Статус |
|---|---|---|
| CSI Timeweb | panel addon | controller+node Running, PVC NVMe Bound |
| local-path-provisioner | v0.0.32 | установлен, не default |
| Istio base/istiod | 1.30.5 | Running |
| istio-ingressgateway | 1.30.5 | DaemonSet 1/1, pinned на worker-192.168.0.5 (nodeAffinity), hostPort 80/443 |
| Gateway ryadom-gateway | GW API v1.4.0 | Programmed, :80→301, :443 TLS |
| cert-manager | 1.21.2 | Running, ClusterIssuer letsencrypt-prod Ready |
| Certificate ryadom-tls | LE | Ready, корневой домен |
| CNPG operator | helm latest | Running |
| PostgreSQL ryadom-db | 16.4 | 2/2 healthy, WAL→S3 (префикс ryadom-db-twc), initial backup OK, daily ScheduledBackup |
| Redis | 7.4.2 | 1/1, PONG |
| Langfuse | image 3.15, chart 1.5.41 | internal-only (port-forward 3000) |
| DNS | Yandex Cloud DNS | корневая A → 185.207.64.68 (единая точка входа) |
