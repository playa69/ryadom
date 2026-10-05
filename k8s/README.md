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
там CNPG и Redis), `monitoring` (без injection — Prometheus/Loki/Grafana).
Только production, dev/stage не нужны — при появлении добавить по образцу
prod.

## Структура

```
k8s/
├── README.md                       ← этот файл
├── CLOUD-RESOURCES.md              ← инвентарь YC: S3, DNS, registry, SA, ключи
├── prepare-secrets.sh              ← генератор base64 для секретов
├── twc-sber500-config.yaml         ← kubeconfig (в .gitignore!)
├── namespaces/manifests/
│   ├── 00-namespaces.yaml          ← prod (+istio-injection), infra, ryadom-db, monitoring
│   ├── 01-network-policy-prod.yaml    ← + egress в ryadom-db:5432/6379/26379, ingress :15090 от monitoring
│   ├── 02-network-policy-infra.yaml   ← + egress в ryadom-db:5432/6379/26379, ingress :3000/9091 от monitoring
│   ├── 03-network-policy-ryadom-db.yaml
│   ├── 04-network-policy-kube-apiserver.yaml  ← egress на 192.168.0.4:6443 (урок post-DNAT)
│   └── 07-network-policy-prod-apps.yaml  ← ingress от gateway на :3000–3003 (сервисы app/)
├── istio/
│   ├── values-istiod.yaml          ← helm values control plane
│   ├── values-ingressgateway.yaml  ← helm values gateway (DaemonSet + hostPort)
│   └── manifests/
│       ├── 00-example-gateway.yaml ← ШАБЛОН HTTPRoute (path-based)
│       ├── 01-gateway-api-gateway.yaml  ← Gateway ryadom-gateway (manual, GW API) + listener'ы поддоменов
│       └── 02-http-redirect-apps.yaml   ← редирект 80→443 для app./web./admin.
├── cert-manager/manifests/
│   ├── 00-cluster-issuer.yaml      ← letsencrypt-prod, solver gatewayHTTPRoute
│   ├── 01-certificate-ryadom-tls.yaml   ← cert на корневой домен → istio-system
│   └── 02-certificate-apps-tls.yaml     ← cert на app./web./admin. (отдельный от корневого)
├── app/                            ← сервисы из app/ репозитория (ns prod): см. раздел ниже
│   ├── 00-app-config.yaml          ← ConfigMap app-config (всё статическое и несекретное)
│   ├── create-secrets.sh           ← app-secrets.env (вне git) → Secret'ы кластера (kubectl create, не apply)
│   ├── build-push.sh               ← сборка и push образов в cr.yandex
│   ├── db/                         ← 01-job-create-db (роль+БД app, citext), 02-job-migrate (drizzle)
│   └── api/ admin/ web/ landing/   ← 01-service, 02-httproute, 03-deployment (admin/ ещё 00-config: ADMIN_EMAILS)
├── tls/                            ← РЕЗЕРВ: lego DNS-01 runbook (не используется,
│                                     рабочая схема — cert-manager HTTP-01)
├── postgres/manifests/
│   ├── 00-secrets.yaml             ← ШАБЛОН, реальные значения не коммитим
│   ├── 01-cnpg-cluster.yaml        ← CNPG ryadom-db, 2 инстанса, NVMe, backup→S3
│   ├── 02-cnpg-backup.yaml         ← ScheduledBackup (daily → S3)
│   └── 03-network-policy.yaml      ← ingress к подам PG (+ :9187 от monitoring)
├── redis/
│   ├── values-redis-sentinel.yaml  ← helm values bitnami/redis 28.3.1 (3 ноды + Sentinel)
│   └── manifests/
│       ├── 00-secret.yaml          ← ШАБЛОН redis-credentials
│       └── 03-network-policy.yaml  ← :6379/:26379 от prod, infra, same-ns
├── langfuse/
    ├── values-langfuse.yaml        ← helm values (PG=CNPG, CH 1 реплика, свой Redis, S3)
    └── manifests/
        ├── 00-secrets.yaml         ← ШАБЛОНЫ секретов Langfuse (+ копия в ryadom-db)
        ├── 01-job-create-db.yaml   ← Job: роль+база langfuse в CNPG
        └── 02-gateway.yaml         ← ШАБЛОН HTTPRoute /langfuse на будущее, НЕ применять
└── monitoring/
    ├── values-prometheus.yaml      ← kube-prometheus-stack 91.8.2 (Alertmanager off, retention 3d)
    ├── values-loki.yaml            ← grafana/loki 7.3.0 (SingleBinary, filesystem PVC 5Gi)
    ├── values-alloy.yaml           ← grafana/alloy 1.13.0 (DaemonSet, сбор логов → Loki)
    ├── dashboards/
    │   └── cluster-resources.json  ← источник JSON дашборда «Ресурсы кластера»
    └── manifests/
        ├── 01-network-policy.yaml  ← default-deny + egress scrape/DNS/apiserver
        └── 02-dashboard-cluster-resources.yaml  ← ConfigMap grafana_dashboard=1 (sidecar)
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

## Реестр образов: зеркало в Yandex Container Registry

Все образы workload'ов кластера зеркалированы в `cr.yandex/crpsqeamqpuvrkm5tpr9`
(Yandex Cloud) и все values/манифесты переведены на pull оттуда — кластер не
зависит от доступности/rate-limit'ов docker.io, quay.io, ghcr.io,
registry.k8s.io, registry.istio.io. Схема имён, SA и ключи — в
`CLOUD-RESOURCES.md` (раздел Container Registry).

- Pull — k8s-секрет `registry-pull` (dockerconfigjson от SA
  ryadom-registry-puller) в namespace prod, infra, ryadom-db, monitoring,
  istio-system, cert-manager, cnpg-system. Проброшен в поды через
  imagePullSecrets в values/манифестах (istio — через global.imagePullSecrets
  istiod: инъектор добавляет в meshed-поды сам).
- Добавление нового helm-чарта/образа: зеркалировать образ в cr.yandex
  (`docker pull --platform linux/amd64` → tag → push), прописать
  registry/repository + imagePullSecrets в values, убедиться что в целевом
  namespace есть секрет registry-pull.
- Системные образы (kube-system, Calico, csi-driver-timeweb-cloud,
  local-path-provisioner) — НЕ зеркалированы осознанно: managed-сущности
  Timeweb/k0s, тянутся с cr-internal.twcstorage.ru и registry.k8s.io.
- Bitnami-валидатор образов (chart redis 28.x) обходится
  `global.security.allowInsecureImages: true` — в зеркале те же битнами-образы.

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
Корневой домен — path-based маршрутизация через HTTPRoute (шаблон
`istio/manifests/00-example-gateway.yaml`; Python backend — `/api/v1`).
Wildcard нет. Для сервисов из `app/` (с 2026-10-05) выделены явные
поддомены `app.`, `web.`, `admin.` со своим сертификатом — см. раздел
«Сервисы из app/» ниже.

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
   (ACME + редирект 301→https) и :443 (certificateRef ryadom-tls); плюс
   listener'ы `https-app/https-web/https-admin` для поддоменов сервисов из
   `app/` (certificateRef ryadom-apps-tls).

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
| `grafana-admin-credentials` | monitoring | `admin-user`, `admin-password` |

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

kubectl apply -f redis/manifests/03-network-policy.yaml   # до или сразу после helm
helm install redis bitnami/redis -n ryadom-db --version 28.3.1 \
  -f redis/values-redis-sentinel.yaml
kubectl exec -n ryadom-db redis-node-0 -c sentinel -- sh -c \
  'redis-cli -p 26379 -a "$REDIS_PASSWORD" --no-auth-warning \
   SENTINEL get-master-addr-by-name mymaster'

kubectl apply -f langfuse/manifests/00-secrets.yaml
kubectl apply -f langfuse/manifests/01-job-create-db.yaml
helm install langfuse langfuse/langfuse -n infra \
  -f langfuse/values-langfuse.yaml --version 1.5.41
```

### 2. Мониторинг (Prometheus + Loki + Grafana)

```bash
# ns monitoring уже создан на шаге 1 (namespaces/manifests/00)
# Секрет grafana-admin-credentials — заранее (kubectl create, пароль из
# ~/.config/ryadom/k8s-secrets.env, ключ GRAFANA_ADMIN_PASSWORD)
kubectl apply -f monitoring/manifests/   # NetworkPolicy + дашборд (ConfigMap)

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm install prometheus prometheus-community/kube-prometheus-stack \
  -n monitoring -f monitoring/values-prometheus.yaml --version 91.8.2
helm install loki grafana/loki \
  -n monitoring -f monitoring/values-loki.yaml --version 7.3.0
helm install alloy grafana/alloy \
  -n monitoring -f monitoring/values-alloy.yaml --version 1.13.0
```

## Доступы: кластер и облако

### Доступ людей/CI к кластеру (kubectl)

- **Админский kubeconfig** `twc-sber500-config.yaml` (cluster-admin из
  панели Timeweb) — только у владельца.
- **Разработчики** — общий SA `developer` (namespace agent) + RBAC
  (k8s/rbac/) + ограниченный kubeconfig
  `~/.config/ryadom/developer-kubeconfig.yaml` (раздаётся команде,
  в git не коммитить). Подробности и команды — в разделе
  «Доступы для разработчиков» ниже.
- **CI** — отдельный `ci-deploy` пока не заведён (TODO до подключения CI),
  паттерн тот же.

**Разница admin / developer:**

| | Админ (`twc-sber500-config.yaml`) | Developer (`developer-kubeconfig.yaml`) |
|---|---|---|
| Идентичность | cluster-admin сертификат Timeweb | SA `developer` (ns agent) + RBAC (k8s/rbac/) |
| Зона ответственности | весь кластер: инфра, NetworkPolicy, Istio, БД, мониторинг, node-level | только ns `agent`/`backend` (полный CRUD своих workload'ов) |
| БД и Langfuse | управление (секреты, рестарты, удаление) | read-only + port-forward + логи (debug); креды PG/Redis — Secret `db-credentials` в agent/backend (PG-юзер `developer`, не superuser) |
| prod, monitoring, istio-system | полный доступ | полный запрет (даже read) |
| Cluster-scope (CRD, RBAC, NetworkPolicy, namespaces) | да | нет (только get/list namespaces и nodes) |
| pods/exec, delete подов в ryadom-db | да | нет |
| Кому выдаётся | только владельцу, не передаётся | всей команде разработки |
| Компрометация = | потеря всего кластера и данных | ущерб ограничен ns agent/backend; отзыв — `kubectl delete secret developer-token -n agent` + перевыпуск |

### ServiceAccount внутри кластера (рабочие)

| SA | Namespace | Кто использует |
|---|---|---|
| `istiod`, `istio-ingressgateway`, `istio-reader-service-account` | istio-system | control plane, gateway |
| `ryadom-db` | ryadom-db | инстансы CNPG (ходят в K8s API — см. 04-network-policy) |
| `db-jobs` | ryadom-db | админ-Job'ы (create-langfuse-db) |
| `redis` | ryadom-db | поды redis-node (создаёт чарт bitnami/redis) |
| `langfuse`, `langfuse-clickhouse`, `langfuse-redis-primary` | infra | чарт Langfuse |
| `developer` | agent | общий SA коллег-разработчиков (деплой в agent/backend, debug — см. «Доступы для разработчиков») |

### Доступ к Yandex Cloud из кластера (через Secrets)

| Secret | Namespace | Что внутри | SA в YC |
|---|---|---|---|
| `cnpg-backup-s3-credentials` | ryadom-db | статический S3-ключ (бэкапы → ryadom-cnpg-backups) | `ryadom-backups` |
| `langfuse-s3-credentials` | infra | статический S3-ключ (blobs → ryadom-app-storage) | `ryadom-app-storage` |
| `registry-pull` | prod, infra, ryadom-db, monitoring, istio-system, cert-manager, cnpg-system, agent, backend | dockerconfigjson для pull из зеркала cr.yandex/crpsqeamqpuvrkm5tpr9 (imagePullSecret всех workload'ов) | `ryadom-registry-puller` |
| `ryadom-tls` | istio-system | LE-сертификат корневого домена (создаёт cert-manager); копия в prod — при публикации Gateway из prod | — |

Ключ SA `ryadom-dns` (dns.editor) в кластер НЕ загружался — HTTP-01 его не
требует; нужен только для резервной схемы DNS-01 (tls/TLS-RUNBOOK.md,
шаблон `tls/manifests/00-secret-yandex-authorized-key.yaml`).

## Доступы для разработчиков

Коллеги работают с кластером через общий ServiceAccount `developer`
(namespace agent, манифесты — k8s/rbac/). Каждому выдаётся файл
`developer-kubeconfig.yaml` (хранится у владельца в
`~/.config/ryadom/developer-kubeconfig.yaml`, права 600; в git не
коммитить, токен не публиковать). Использование:

```bash
export KUBECONFIG=~/путь/к/developer-kubeconfig.yaml
kubectl get pods -n agent
```

**Что разрешено:**

| Где | Права | Роль (k8s/rbac/) |
|---|---|---|
| `agent`, `backend` | полный CRUD: deployments, statefulsets, pods, services, configmaps, secrets, pvc, jobs/cronjobs, ingresses, httproutes + логи/port-forward своих подов | ClusterRole `developer-deploy` (RoleBinding в обоих ns) |
| `ryadom-db` (postgres, redis), `infra` (langfuse) | read-only (pods/services/endpoints/statefulsets, логи) + `pods/portforward` | ClusterRole `developer-debug` |
| весь кластер | get/list namespaces, nodes (ориентироваться) | ClusterRole `developer-read-cluster` (ClusterRoleBinding) |

**Что запрещено:** любые изменения вне agent/backend (prod, monitoring,
istio-system, cert-manager, cnpg-system — read тоже нет), secrets вне
agent/backend, cluster-scope ресурсы (RBAC, CRD, NetworkPolicy и т.п.),
pods/exec нигде.

**Port-forward для отладки:**

```bash
# PostgreSQL (CNPG, rw — primary)
kubectl port-forward -n ryadom-db svc/ryadom-db-rw 5432:5432
# Redis (через Sentinel-выбранный master) и сам Sentinel
kubectl port-forward -n ryadom-db svc/redis 6379:6379
kubectl port-forward -n ryadom-db svc/redis 26379:26379
# Langfuse UI
kubectl port-forward -n infra svc/langfuse-web 3000:3000
```

**Креды БД для разработчиков** — Secret `db-credentials` в namespace
`agent` и `backend` (читается их RBAC, значения одинаковые в обоих ns):

```bash
# пример: прочитать пароль postgres
kubectl get secret db-credentials -n agent \
  -o jsonpath='{.data.postgres-password}' | base64 -d
```

Поля: `postgres-host` (`ryadom-db-rw.ryadom-db.svc.cluster.local`; при
port-forward — `localhost`), `postgres-port` 5432, `postgres-user`
`developer`, `postgres-password`, `postgres-db-agent` / `postgres-db-backend`
(базы уже созданы, owner — developer); `redis-host`
(`redis.ryadom-db.svc.cluster.local`), `redis-port` 6379,
`redis-sentinel-port` 26379, `redis-master-name` `mymaster`,
`redis-password`.

- PG-пользователь `developer`: LOGIN + CREATEDB, БЕЗ superuser/createrole
  (managed role в `postgres/manifests/01-cnpg-cluster.yaml`, пароль —
  Secret `developer-pg-role` в ryadom-db). Свои базы (`agent`, `backend`)
  и новые БД через CREATEDB — можно; чужие базы (langfuse, ryadom) и роли —
  нельзя.
- Redis — один общий AUTH-пароль на всех (ограничение bitnami
  redis+sentinel: ACL-пользователи усложняют репликацию). Hardening
  через Redis ACL — отдельная будущая задача.

NB: `kubectl auth can-i` клиента v1.34 против сервера v1.36 глючит на
сабресурсах (pods/portforward шлётся как name=portforward, а не
subresource) — проверять права на сабресурсы через
SelfSubjectAccessReview (kubectl create --validate=false -f -).

## Модель NetworkPolicy

Default-deny ingress+egress в каждом namespace; разрешены: ingress от
istio-ingressgateway, pod-to-pod внутри namespace, DNS (kube-system :53),
HTTPS наружу (:443 — LLM API, S3), egress на kube-apiserver
(04-network-policy-kube-apiserver.yaml), для meshed ns — сайдкары → istiod
(:15012/:15010). Меж-namespace только явные prod/infra → ryadom-db:5432/6379/26379
и scrape от ns monitoring → :15090 (prod), :3000/9091 (infra), :9187
(ryadom-db, в postgres/manifests/03). В самом monitoring — свои политики
(monitoring/manifests/01-network-policy.yaml), включая ingress с IP нод
(kubelet-пробы, kubectl port-forward) и на webhook оператора :9443 от
konnectivity/192.168.0.4 (без него helm install kube-prometheus-stack
не проходит).

**Урок (Calico post-DNAT):** egress-политика применяется ПОСЛЕ DNAT
kube-proxy: обращение к kubernetes.default 10.96.0.1:443 превращается в
192.168.0.4:6443, и правило «:443 наружу» его НЕ покрывает — поды CNPG
(initdb/join) не достукиваются до API, bootstrap висит. Лечение — явный
egress из `04-…yaml`. Актуальный endpoint: `kubectl get endpoints kubernetes`.

**TODO по ужесточению:** сузить egress 0.0.0.0/0:443 до CIDR LLM-провайдеров;
REGISTRY_ONLY + ServiceEntry-allowlist + AuthorizationPolicy-матрица —
после появления приложений (паттерн UnionApp/k8s/cluster-policies/istio-isolation/).

## Redis + Sentinel

Общий кэш/очереди прикладных сервисов prod (Langfuse использует свой
bundled Redis в infra). До 2026-10-01 был standalone-манифест (1 реплика,
удалён), заменён на Bitnami chart `redis` 28.3.1 (Redis 8.10.2) с Sentinel
— `redis/values-redis-sentinel.yaml`.

Топология: единый StatefulSet `redis-node`, 3 пода (в каждом контейнеры
`redis` + `sentinel`), hard anti-affinity по нодам (по поду на ноду).
NB: в chart 28.x размер STS = `replica.replicaCount` (мастер отдельно не
считается — он выбирается sentinel'ом среди подов, masterSet `mymaster`,
quorum 2). PVC 5Gi NVMe на под, maxmemory 256mb allkeys-lru — как у
бывшего standalone. Пароль — тот же Secret `redis-credentials`
(клиенты не меняются), применяется и к sentinel (auth.sentinel=true).

Подключение из приложений: чарт создаёт ЕДИНЫЙ Service `redis`
(ClusterIP, 6379 + 26379 на все поды). Sentinel-aware клиент — на
`redis:26379` (имя мастера `mymaster`); либо разрешить мастер через
sentinel на старте и ходить на узел напрямую. Адрес мастера всегда можно
узнать: `SENTINEL get-master-addr-by-name mymaster`.

Failover проверен (2026-10-01): удаление пода мастера → новый мастер за
~10 с (sentinel quorum 2/3), данные на месте, вернувшийся под встаёт
репликой и догоняет.

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

## Мониторинг: Prometheus + Loki + Grafana

Стек в ns `monitoring` (без istio-injection), доступ — только ClusterIP +
port-forward, наружу НЕ публикуется.

- **kube-prometheus-stack 91.8.2** (`monitoring/values-prometheus.yaml`):
  Prometheus (retention 3d / 3GB, PVC 5Gi NVMe), Grafana (PVC 2Gi),
  node-exporter (DaemonSet, hostNetwork :9100), kube-state-metrics.
  **Alertmanager отключён** осознанно — алертам некуда доставляться;
  включение = отдельный шаг. Managed control plane: scrape etcd/scheduler/
  controller-manager/kube-proxy отключён (их нет в кластере).
- **Loki 7.3.0** (`monitoring/values-loki.yaml`): SingleBinary, filesystem
  PVC 5Gi NVMe, retention 7d. S3 — next step (комментарий в values):
  object_store на bucket ryadom-app-storage, дешевле и переживает PVC.
- **Alloy 1.13.0** (`monitoring/values-alloy.yaml`): DaemonSet-сборщик
  pod-логов → Loki (promtail deprecated — не используем).

Дополнительные scrape-jobs (additionalScrapeConfigs): `istio-proxy`
(:15090, порт http-envoy-prom — сайдкары будущих приложений и сам
ingressgateway), `cnpg` (инстансы ryadom-db :9187). Grafana datasource Loki
добавлен через values (`grafana.additionalDataSources`).

Доступ к Grafana: `kubectl port-forward -n monitoring svc/prometheus-grafana
3000:80` → http://localhost:3000, логин `admin`, пароль — ключ
`GRAFANA_ADMIN_PASSWORD` в `~/.config/ryadom/k8s-secrets.env`
(секрет `grafana-admin-credentials`). Prometheus UI: port-forward на
svc/prometheus-kube-prometheus-prometheus 9090. Loki: svc/loki 3100.

Дашборды — как код: JSON в `monitoring/dashboards/`, ConfigMap с label
`grafana_dashboard=1` в `monitoring/manifests/` — подхватывается sidecar'ом
grafana-sc-dashboard (~30s после apply, переживает пересоздание пода).
Свой дашборд «Ryadom — Ресурсы кластера» (uid `cluster-resources`,
manifests/02-dashboard-cluster-resources.yaml): CPU/RAM usage/requests/limits
кластера и по namespace, requests/limits vs capacity нод, ноды
(node-exporter), поды, RPS и HTTP-статусы istio-ingressgateway
(`istio_requests_total`, job istio-proxy). Регенерация ConfigMap после
правки JSON: `kubectl create configmap cluster-resources-dashboard
-n monitoring --from-file=cluster-resources.json=dashboards/cluster-resources.json
--dry-run=client -o yaml > manifests/02-dashboard-cluster-resources.yaml`
(не забыть вернуть labels в metadata).

## Сервисы из app/ (ns prod)

Node-приложения «Рядом» из каталога `app/` репозитория (отдельно от Python
`backend/` в ns `backend`). Манифесты — `k8s/app/`, образы —
`cr.yandex/crpsqeamqpuvrkm5tpr9/app/<name>:<tag>`.

| Сервис | Адрес | Порт | Что |
|---|---|---|---|
| `app-landing` | `слышу-рядом.рф` (корень, `/`) | 3000 | маркетинг, документы; `/api/v1` остаётся у Python backend (длиннейший префикс) |
| `app-api` | `app.<домен>` | 3002 | REST `/api/*`, WebSocket к агенту, PWA/OTA |
| `app-web` | `web.<домен>` | 3003 | веб-клиент после входа (ходит в API на `app.`) |
| `app-admin` | `admin.<домен>` | 3001 | админка (вход по `ADMIN_EMAILS`) |
| `app-migrate` | — | — | Job drizzle-миграций БД `app` |

`<домен>` = `xn----htbtgjker8b3a2c.xn--p1ai`. Общий ConfigMap `app-config`
(+ `app-admin-config` для админки), секреты `app-secrets`/`app-smtp`
(создаются скриптом из локального файла, в git их нет). БД — тот же сервер
CNPG `ryadom-db` (`ryadom-db-rw.ryadom-db:5432`), что у Python backend, но
**своя база и своя роль `app`**: у backend база `backend` и роль `developer`.
Базу, роль и расширение `citext` создаёт Job `create-app-db`.

**Мобильный клиент** использует именно `app-api` (`app.<домен>`, это
`app/services/api`), а не Python backend: адрес вшивается в образ api при
сборке (`VITE_PROD_API_URL` в `build-push.sh`) и попадает в PWA и OTA-бандлы.
Python backend (`/api/v1` на корне) живёт отдельно и мобильным клиентом не
используется.

### Redis (включён)

Общий Redis `ryadom-db` (Sentinel) нужен только `app-api` — для счётчиков
лимитов запросов (вход, коды из писем, регистрация устройства). Ключи
`ryadom:rl:*` (префикс по умолчанию; Python backend пишет свои счётчики как
`rl:*` и коды писем, так что пересечений нет) с TTL окна; пароль — `REDIS_PASSWORD` в `app-secrets`. Если Redis недоступен,
api сам считает лимиты в памяти (`lib/redis-rate-limiter.ts`), то есть
отказ Redis не кладёт вход. Сетевые правила уже есть: `prod` → `ryadom-db`
:6379/:26379 (01-network-policy-prod) и приём из `prod` на стороне Redis
(`redis/manifests/03-network-policy.yaml`). Ручных шагов нет: пароль копирует
`create-secrets.sh` из `ryadom-db/redis-credentials`, адреса — в `app-config`.
Общий Redis работает с `allkeys-lru` на 256 МБ: счётчики крошечные, но при
нехватке памяти вытесняться могут и ключи соседей — следить за памятью Redis.
Проверка после выката: `kubectl -n prod logs deploy/app-api | grep -i redis`
→ «Redis подключён»; ключи — `kubectl -n ryadom-db exec redis-node-0 -c redis
-- sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --scan --pattern "ryadom:rl:*"'`.
Раз лимиты общие, `replicas` у api можно поднимать, когда хватит ресурсов.

### IP клиента и лимиты запросов

Лимиты привязаны к IP клиента. Istio-gateway ДОПИСЫВАЕТ реальный адрес в конец
`X-Forwarded-For`, а всё левее клиент пишет сам. Поэтому IP берётся из записи,
добавленной доверенным прокси (`TRUSTED_PROXY_HOPS=1` в `app-config`), а не из
первой: иначе подмена заголовка давала бы новый счётчик на каждый запрос.
Если перед gateway появится CDN или балансировщик — поставить 2.
Проверка после выката (потратит лимит device-login вашего IP на час):

```bash
D=$(uuidgen); K=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
for i in $(seq 1 32); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST https://app.<домен>/api/auth/device \
    -H 'Content-Type: application/json' -H "X-Forwarded-For: 198.51.100.$i" \
    -d "{\"deviceId\":\"$D\",\"deviceKey\":\"$K\"}"
done   # ожидается: 200 ×30, затем 429 — несмотря на разные подставные адреса
```

### Секреты и конфиги

**Правило: секреты — в локальном `.env`-файле и Secret'ах, всё статическое
несекретное — в ConfigMap'ах (в git).**

| Что | Где | Примеры |
|---|---|---|
| Статика, несекретное | ConfigMap `app-config` ([00-app-config.yaml](app/00-app-config.yaml)) | `DB_HOST/PORT/NAME/USER`, публичные URL, `TRUSTED_PROXY_HOPS`, `REDIS_*` адреса, флаги |
| Статика только админки | ConfigMap `app-admin-config` ([admin/00-config.yaml](app/admin/00-config.yaml)) | `ADMIN_EMAILS` (в API он попадать не должен) |
| Секреты | `app-secrets.env` в корне репозитория → Secret'ы кластера | `DB_PASSWORD`, `AUTH_SECRET`, `MOBILE_JWT_SECRET`, `AGENT_API_TOKEN`, `SMTP_PASSWORD` |

`DATABASE_URL` нигде не хранится: Deployment'ы собирают его из `DB_*`
(ConfigMap) и `DB_PASSWORD` (Secret). Пароль Redis в файл не пишется: скрипт
копирует его из `ryadom-db/redis-credentials`.

Файл `app-secrets.env` — источник секретов при деплое. Он создаётся один раз
(`bash k8s/app/create-secrets.sh --generate-only`, кластер не нужен), лежит
вне git (скрыт локально через `.git/info/exclude`, `.gitignore` не менялся;
скрипт отказывается работать с файлом, который git не игнорирует) и читается
обычным запуском скрипта, который создаёт Secret'ы в кластере. Недостающие
значения дописываются в файл ДО создания секретов; при сбое в кластере ничего
не создаётся, а повторный запуск берёт значения из файла. В новом клоне
исключение нужно добавить заново (скрипт подскажет команды).

Копию файла положите в менеджер паролей: при потере кластера без неё все
сессии пользователей станут недействительны (`AUTH_SECRET`). Права 0600
скрипт выставляет там, где ФС это поддерживает, и предупреждает, если нет
(NTFS, `/mnt/c` в WSL). Позже подключить почту: `SMTP_PASSWORD=... bash
k8s/app/create-secrets.sh --smtp-only` (+ `SMTP_HOST/PORT/SECURE/USER` и
`EMAIL_TRANSPORT=smtp` в `app-config`, правило egress в NetworkPolicy).

### Что сознательно выключено на первом выкате

- **Почта** (`EMAIL_TRANSPORT=console`): провайдер выбран — Yandex Cloud
  Postbox, egress на :465 описан в `07-network-policy-prod-apps.yaml`, SMTP-хост
  и порт — в `00-app-config.yaml`; осталось завести DNS-записи и API-ключ
  (раздел «DNS и почта: что сделать руками») и переключить транспорт.
  Вход в админку идёт по коду из письма, поэтому сейчас код берётся из лога:
  `kubectl -n prod logs deploy/app-admin | grep -i "console transport"`.
  Побочный эффект: все коды (привязка почты, сброс пароля) попадают в логи и
  Loki — на время `console` это приемлемо, для реальных пользователей нет.
- **Agent** (`AGENT_API_URL` — плейсхолдер): сервиса агента в кластере пока
  нет (`agent/` — заготовка без Dockerfile). api стартует, но диалоги и
  стирание данных у агента не работают; `ANONYMOUS_PURGE_DISABLED=true`.
- 1 реплика на сервис: ресурсов в кластере впритык (см. «Доступные ресурсы»).

### DNS и почта: что сделать руками (Yandex Cloud, консоль)

Все записи — в Cloud DNS, зона `slyshu-ryadom` (NS домена уже у Yandex Cloud,
в reg.ru ничего заводить не нужно). Имена в зоне — относительные (`app`, а не
полный punycode). Всё одним пакетом: проверка DKIM у Postbox идёт до суток, так
что начинать с почты, а не с A-записей.

| Имя | Тип | Значение | Зачем |
|---|---|---|---|
| `app` | A | `185.207.64.68` | api + PWA |
| `web` | A | `185.207.64.68` | веб-клиент |
| `admin` | A | `185.207.64.68` | админка |
| 2 записи из консоли Postbox | CNAME | как покажет консоль | DKIM (Easy DKIM) |
| `@` | TXT | `"v=spf1 include:spf.postbox.yandexcloud.net ~all"` | SPF; на домене он может быть только один — позже другие отправители дописываются в эту же запись |
| `_dmarc` | TXT | `"v=DMARC1;p=none"` | DMARC (ужесточить позже) |

TTL 300. `api.` не заводим: мобильный клиент и PWA вшиты на `app.`. Проверка:
`nslookup app.xn----htbtgjker8b3a2c.xn--p1ai 8.8.8.8` → `185.207.64.68`.

Postbox ([документация](https://yandex.cloud/ru/docs/postbox/quickstart)):

1. Сервисный аккаунт (напр. `ryadom-postbox`) с ролью `postbox.sender` в том же
   каталоге, что и зона DNS.
2. API-ключ этого аккаунта с областью `yc.postbox.send`. Секретная часть
   показывается один раз: сразу в `app-secrets.env` как `SMTP_PASSWORD`, в чаты
   и коммиты — нет. Идентификатор ключа — это `SMTP_USER` (несекретный).
3. Адрес (identity) для домена `xn----htbtgjker8b3a2c.xn--p1ai` (punycode;
   про кириллицу документация молчит), настройка DKIM — «Простая». Консоль
   покажет две CNAME-записи — добавить в зону. Статус должен стать `Success`.
   Отправлять можно с `noreply@<домен>`, но не с поддомена `x@mail.<домен>`.
4. Проверить в консоли Postbox лимиты и ограничения на отправку (в
   документации они не описаны).
5. Секрет в кластер: `bash k8s/app/create-secrets.sh --smtp-only` (нужен админский
   kubeconfig). Затем в `00-app-config.yaml` раскомментировать `SMTP_USER`,
   `EMAIL_TRANSPORT: "smtp"` и применить вместе с
   `07-network-policy-prod-apps.yaml` (там egress на :465).
6. До отключения `console` убедиться, что письмо доходит на `ADMIN_EMAILS`:
   вход в админку идёт по коду из письма. Откат — вернуть `console` и взять код
   из лога.

Входящей почты у домена нет (Postbox только отправляет): `support@` и ответы на
`noreply@` пока уходят в никуда — нужны MX (напр. Яндекс 360 для домена) и
замена `PUBLIC_SUPPORT_EMAIL`.

Для выката нужны на машине оператора: Docker, kubectl, **админский** kubeconfig
(`k8s/twc-sber500-config.yaml`, в git его нет), `registry-pusher-key.json` в
корне репозитория и `app-secrets.env`.

### Первый выкат (порядок важен)

Нужны Docker (WSL/Docker Desktop), `kubectl` и **админский** kubeconfig
(`prod`, NetworkPolicy, Gateway, cert-manager и создание БД — вне роли
`developer`). Применять **поимённо** (`-f k8s/app/...`), а не `-f k8s/`
целиком: в других каталогах лежат шаблоны секретов с `CHANGE_ME`, которые
перезапишут реальные.

```bash
export KUBECONFIG=~/.kube/ryadom-admin.yaml
kubectl get nodes && kubectl -n prod get pods          # read-only проверка доступа
kubectl -n istio-system get gateway ryadom-gateway -o yaml > /tmp/gateway-backup.yaml

# 1. Секреты и БД. Источник — app-secrets.env в корне репозитория (создаётся
#    командой `bash k8s/app/create-secrets.sh --generate-only`, вне git)
bash k8s/app/create-secrets.sh
kubectl apply -f k8s/app/db/01-job-create-db.yaml
kubectl -n ryadom-db wait --for=condition=complete job/create-app-db --timeout=120s

# 2. Образы (--login берёт registry-pusher-key.json из корня репозитория).
#    Сначала можно только собрать локально, без отправки: --no-push 0.1.0
bash k8s/app/build-push.sh --login 0.1.0

# 3. DNS: A-записи app./web./admin. → 185.207.64.68 (Yandex Cloud DNS, зона
#    slyshu-ryadom), проверить nslookup. Затем сертификат:
kubectl apply -f k8s/cert-manager/manifests/02-certificate-apps-tls.yaml
kubectl -n istio-system wait --for=condition=ready certificate/ryadom-apps-tls --timeout=300s

# 4. Сеть, конфиг, миграции
kubectl apply -f k8s/namespaces/manifests/07-network-policy-prod-apps.yaml
kubectl apply -f k8s/app/00-app-config.yaml -f k8s/app/admin/00-config.yaml
kubectl apply -f k8s/app/db/02-job-migrate.yaml
kubectl -n prod wait --for=condition=complete job/app-migrate-0001 --timeout=180s

# 5. Сервисы — ПО ОДНОМУ, следя за ресурсами (kubectl top nodes / дашборд)
for s in api landing web admin; do
  kubectl apply -f k8s/app/$s/01-service.yaml -f k8s/app/$s/03-deployment.yaml
  kubectl -n prod rollout status deploy/app-$s --timeout=180s
done

# 6. Маршруты и Gateway — В САМОМ КОНЦЕ (Gateway общий с Python backend)
kubectl apply -f k8s/app/api/02-httproute.yaml -f k8s/app/web/02-httproute.yaml \
  -f k8s/app/admin/02-httproute.yaml -f k8s/app/landing/02-httproute.yaml
kubectl diff -f k8s/istio/manifests/01-gateway-api-gateway.yaml      # только новые listener'ы!
kubectl apply -f k8s/istio/manifests/01-gateway-api-gateway.yaml -f k8s/istio/manifests/02-http-redirect-apps.yaml
kubectl -n istio-system get gateway ryadom-gateway                   # Programmed=True
```

Проверка: `curl https://app.<домен>/api/health` → 200; логи api: «Redis
подключён»; проверка IP-лимитов (раздел выше); `web.`, `admin.`,
корень отдают страницы; **регресс** — `https://<домен>/api/v1/...` Python
backend отвечает как раньше. Откат: `kubectl delete -f k8s/app/<svc>/...`;
Gateway — вернуть файл из git и `apply` (бэкап живого — `/tmp/gateway-backup.yaml`);
БД `app` удалять только осознанно (есть daily-бэкап CNPG).

### Новая версия

`bash k8s/app/build-push.sh 0.1.1 api` → поправить тег в
`k8s/app/api/03-deployment.yaml` → `kubectl apply` → `rollout status`.
Для миграций — Job `app-migrate-0002` с новым образом `app/migrate:0.1.1`.

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
| Redis + Sentinel | 8.10.2, chart 28.3.1 | 3/3 (redis-node-0/1/2 по нодам), failover проверен |
| Langfuse | image 3.15, chart 1.5.41 | internal-only (port-forward 3000) |
| Prometheus + Grafana | chart 91.8.2 (Prom v0.94.1, Grafana 13.2.3) | Running, все targets UP, Alertmanager off |
| Loki | 3.6.12, chart 7.3.0 | Running, SingleBinary, PVC 5Gi, retention 7d |
| Alloy | v1.20.0, chart 1.13.0 | DaemonSet 3/3, логи всех ns текут в Loki |
| DNS | Yandex Cloud DNS | корневая A → 185.207.64.68 (единая точка входа) |

## Доступные ресурсы кластера (для приложений)

### Свободная ёмкость (2026-10-01, дашборд «Ryadom — Ресурсы кластера»)

| Ресурс | Requests / capacity | Limits / capacity | Фактическое использование |
|---|---|---|---|
| CPU (6 ядер) | 67% | 122% (оверсабскрайб в норме) | 13–23% по нодам |
| RAM (~13 Ги) | 40% | 94% | 30–56% по нодам |

Свободно по requests: ~2 ядра CPU, ~7–8 Ги RAM. Диски: PVC занято ~45 Ги
NVMe (PG 2×10, Redis 3×5, CH 10, Loki 5, Prom 5, Grafana 2, Langfuse-redis).

### Сервисы, доступные приложениям (из ns prod)

| Сервис | Endpoint | Назначение |
|---|---|---|
| PostgreSQL (CNPG) | `ryadom-db-rw.ryadom-db:5432` (write), `ryadom-db-ro.ryadom-db:5432` (read) | основная БД; свои database/роль — через Job по образцу `langfuse/manifests/01-job-create-db.yaml` |
| Redis Sentinel | `redis.ryadom-db:26379` (master `mymaster`), `redis.ryadom-db:6379` (прямой) | кэш/очереди; sentinel-aware клиент предпочтителен |
| Langfuse | `langfuse-web.infra:3000` | LLM-трейсинг (SDK → LANGFUSE_HOST); UI — port-forward |
| Prometheus | scrape по аннотациям pod'ов (`prometheus.io/scrape` — порт открыть в NP ns) | метрики приложения |
| Loki | автоматически (Alloy собирает stdout всех подов) | логи — просто писать в stdout |

### Точки входа

- Публичная: `https://слышу-рядом.рф` → istio-gateway (нода .5) → HTTPRoute.
  Публикация сервиса = HTTPRoute с parentRef на listener `https`
  (шаблон `istio/manifests/00-example-gateway.yaml`) + правило ingress в NP
  namespace.
- Сервисы из `app/` — на поддоменах `app.`/`web.`/`admin.` (listener'ы
  `https-app/-web/-admin`, сертификат `ryadom-apps-tls`), landing — на корне;
  см. раздел «Сервисы из app/».
- Админские UI (ClusterIP + port-forward): Grafana `:3000`
  (`svc/prometheus-grafana`, пароль в `~/.config/ryadom/k8s-secrets.env`),
  Langfuse `:3000` (`svc/langfuse-web`), Prometheus `:9090`
  (`svc/prometheus-kube-prometheus-prometheus`).
