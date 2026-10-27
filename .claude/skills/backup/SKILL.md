---
name: backup
description: Backups of the Ryadom production database — check the freshness of the continuous archive and the daily copies of CNPG ryadom-db, make an on-demand copy before a migration, take a dump of one database, restore plan. Use for questions like "is there a fresh backup", "make a backup before the migration", "take a dump", "download the database", "restore from a backup".
---

# Backups and dumps

The production PostgreSQL (CNPG `ryadom-db`, databases `app`, `agent`, `cognee_db`, `langfuse`) is backed up by the
CloudNativePG operator to Object Storage: a continuous WAL archive and a daily base backup at 03:00 Moscow time
(`ScheduledBackup` `ryadom-db-daily`), retained for 30 days. The settings are in
`k8s/postgres/manifests/01-cnpg-cluster.yaml` and `02-cnpg-backup.yaml`. Since 0.8.0 the agent's dialogs live in the same
database and are covered by the same archive.

Everything below is in ns `ryadom-db`, which means the admin kubeconfig: only after the user's explicit "yes"; an
on-demand copy and a dump — at the user's request.

## Check

```bash
kubectl -n ryadom-db get backups.postgresql.cnpg.io --sort-by=.metadata.creationTimestamp | tail -5   # latest copies and their phase
kubectl -n ryadom-db get scheduledbackups.postgresql.cnpg.io
kubectl -n ryadom-db get cluster ryadom-db \
  -o jsonpath='{.status.lastSuccessfulBackup}{"\n"}{.status.firstRecoverabilityPoint}{"\n"}{.status.conditions[?(@.type=="ContinuousArchiving")].status}{"\n"}'
```

Normal: the latest copy is `completed` and younger than a day, `ContinuousArchiving` = `True`, the recovery point is
within 30 days. The contents of the backup storage are checked by the administrator: only the administrator has the
access key to it.

## On-demand copy

Before a schema migration or a bulk data edit:

```bash
kubectl create -f - <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: ryadom-db-before-<what>-<YYYYMMDD>
  namespace: ryadom-db
spec:
  cluster:
    name: ryadom-db
  target: primary
EOF
kubectl -n ryadom-db get backup ryadom-db-before-<what>-<YYYYMMDD> -w     # wait for phase completed
```

## Dump of one database

```bash
POD=$(kubectl -n ryadom-db get pod -l cnpg.io/cluster=ryadom-db,cnpg.io/instanceRole=primary -o name)
kubectl -n ryadom-db exec "$POD" -c postgres -- pg_dump -U postgres -d app -Fc > app-<YYYYMMDD>.dump
```

The dump contains personal data and conversation texts: keep the file only outside the repository, not in chats or
issues; delete it after the work. `kubectl cp` breaks off on large files (websocket 1006) — hence the stream through
`exec`; compare the size or `sha256sum` with the source.

## Restore

Restore into a **new** CNPG cluster from the same archive (`bootstrap.recovery` with `barmanObjectStore` and, if needed,
`recoveryTarget.targetTime`), not on top of the live one; do not delete the old cluster and its disks until the new one
is verified. This is the user's decision: prepare a plan in the issue (the point in time, the name of the new cluster,
how to switch the applications) and wait for the user's explicit "yes". For the order and the fields see the
CloudNativePG documentation, section "Recovery". Locally a dump is restored like this:
`pg_restore -d <local database> --no-owner app-<YYYYMMDD>.dump` (skill `local-dev`, role `ryadom`).

Related: [[db]] — queries to the database and the data edit protocol; [[deploy]] — migrations during a rollout.
