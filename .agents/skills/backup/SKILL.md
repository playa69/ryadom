---
name: backup
description: Бэкапы базы прода «Рядом» — проверить свежесть непрерывного архива и ежедневных копий CNPG ryadom-db, сделать копию по требованию перед миграцией, снять дамп одной базы, план восстановления. Использовать при вопросах «есть ли свежий бэкап», «сделай бэкап перед миграцией», «сними дамп», «выкачай базу», «восстанови из бэкапа».
---

# Бэкапы и дампы

PostgreSQL прода (CNPG `ryadom-db`, базы `app`, `agent`, `cognee_db`, `langfuse`) бэкапится оператором
CloudNativePG в Object Storage: непрерывный архив WAL и ежедневная базовая копия в 03:00 по Москве
(`ScheduledBackup` `ryadom-db-daily`), хранение 30 дней. Настройки — `k8s/postgres/manifests/01-cnpg-cluster.yaml` и
`02-cnpg-backup.yaml`. С 0.8.0 диалоги агента лежат в той же базе и покрыты тем же архивом.

Всё ниже — в ns `ryadom-db`, это admin-kubeconfig: только после «да» человека, а копия по требованию и дамп — по его
просьбе.

## Проверить

```bash
kubectl -n ryadom-db get backups.postgresql.cnpg.io --sort-by=.metadata.creationTimestamp | tail -5   # последние копии и их фаза
kubectl -n ryadom-db get scheduledbackups.postgresql.cnpg.io
kubectl -n ryadom-db get cluster ryadom-db \
  -o jsonpath='{.status.lastSuccessfulBackup}{"\n"}{.status.firstRecoverabilityPoint}{"\n"}{.status.conditions[?(@.type=="ContinuousArchiving")].status}{"\n"}'
```

Норма: последняя копия `completed` моложе суток, `ContinuousArchiving` = `True`, точка восстановления в пределах 30
дней. Содержимое хранилища бэкапов смотрит администратор: ключ доступа к нему есть только у него.

## Копия по требованию

Перед миграцией схемы или массовой правкой данных:

```bash
kubectl create -f - <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: ryadom-db-before-<что>-<ГГГГММДД>
  namespace: ryadom-db
spec:
  cluster:
    name: ryadom-db
  target: primary
EOF
kubectl -n ryadom-db get backup ryadom-db-before-<что>-<ГГГГММДД> -w     # ждать phase completed
```

## Дамп одной базы

```bash
POD=$(kubectl -n ryadom-db get pod -l cnpg.io/cluster=ryadom-db,cnpg.io/instanceRole=primary -o name)
kubectl -n ryadom-db exec "$POD" -c postgres -- pg_dump -U postgres -d app -Fc > app-<ГГГГММДД>.dump
```

В дампе персональные данные и тексты разговоров: файл — только вне репозитория, не в чатах и задачах; после работы
удалить. `kubectl cp` на больших файлах обрывается (websocket 1006) — поэтому поток через `exec`; сверяй размер или
`sha256sum` с исходником.

## Восстановление

Делается в **новый** кластер CNPG из того же архива (`bootstrap.recovery` с `barmanObjectStore` и при необходимости
`recoveryTarget.targetTime`), а не поверх живого; старый кластер и его диски не удалять, пока новый не проверен.
Это решение владельца: подготовь план в задаче (точка во времени, имя нового кластера, как переключить приложения) и
жди его «да». Порядок и поля — документация CloudNativePG, раздел «Recovery». Локально дамп поднимается так:
`pg_restore -d <локальная база> --no-owner app-<ГГГГММДД>.dump` (скилл `local-dev`, роль `ryadom`).

Связано: [[db]] — запросы к базе и протокол правки данных; [[deploy]] — миграции при выкате.
