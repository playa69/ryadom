---
name: deploy
description: Roll out Ryadom to the Timeweb cluster twc-sber500 — build a linux/amd64 image from a commit, push it to cr.yandex, bump the tag in the k8s/ manifests, check the diff, apply migrations and the Deployment, wait for the rollout and verify it, roll back. Use when asked to "deploy", "roll out the agent", "update api in production", "build an image", "why does the pod not start after a rollout", "roll back", and when changing application ConfigMaps and Secrets.
---

# Rollout to the cluster

All services live in one Timeweb cluster `twc-sber500`; there is a single environment — production. On people's
machines the default kubeconfig may point to another cluster: set it explicitly. Images are in
`cr.yandex/crpsqeamqpuvrkm5tpr9`, manifests are in `k8s/`. The source of truth for the steps is
[k8s/README.md](../../../k8s/README.md) (sections «Сервисы из app/», «Сборка и push образов», «Новая версия»),
[k8s/agent/README.md](../../../k8s/agent/README.md) and the runbooks `k8s/agent/RUNBOOK-*.md`.

| What | Image | Manifest | ns |
|---|---|---|---|
| api, web, admin, landing, pwa | `…/app/<name>:<tag>` | `k8s/app/<name>/03-deployment.yaml` | prod |
| `app` database migrations | `…/app/migrate:<tag>` | `k8s/app/db/0N-job-migrate-000N.yaml`, Job `app-migrate-000N` | prod |
| agent | `…/agent/agent:<tag>` | `k8s/agent/02-deployment.yaml` + `APP_VERSION` in `k8s/agent/00-config.yaml` | agent |
| cognee | `cognee/cognee:<version>` (official) | `k8s/agent/12-cognee-deployment.yaml` | agent |

What is in the cluster now: `kubectl -n prod get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[*].image`
(admin; for `-n agent` developer is enough).

## Rules

- **Roll out only on a direct request**, and to production only with a separate explicit "yes" from the user for this
  rollout. Before it, show: the branch and SHA, images and tags, namespace, `kubectl diff`, whether migrations, Secrets
  and admin are needed.
- **The admin kubeconfig** is needed for everything in `prod` and for creating Secrets; developer is enough for ns
  `agent`. Use admin only after the user's explicit "yes" for the specific operations.
- **Tag**: if it is not given, ask; do not overwrite one that already exists in the registry; do not use `latest`.
- **Repository changes** — in your own branch `deploy/<short-name>` in a separate worktree, commit
  `deploy(agent): образ 0.8.2 — <что внутри> (#PR)` with the build revision and image digest in the body, PR to `main`.
  The user merges.
- **Apply by name**, never `kubectl apply -f k8s/` or `-R k8s/app`: the directories hold Secret templates with
  `CHANGE_ME` and Jobs of past migrations.

`kubectl` and `docker` below are the commands to the cluster and to the registry on this machine (how they connect is
known to the administrator); the build script goes to the registry via `RYADOM_DOCKER` (default `docker`, already logged
in to `cr.yandex`).

## New version

1. **Checks** in the branch you roll out from (skill `local-dev`): tests are green, the commit is pushed.
2. **Build** from a commit, not from the working directory:

   ```bash
   .agents/skills/deploy/scripts/build.sh agent 0.8.2 --ref origin/main          # build only
   .agents/skills/deploy/scripts/build.sh agent 0.8.2 --ref origin/main --push   # build and push
   ```

   The script takes `git archive` of the commit (no `node_modules` and no local edits, with LF), builds
   `buildx --platform linux/amd64 --provenance=false --sbom=false --load` with the required build-args (`BASE_PATH`,
   `PWA_BASE_PATH`, `RELEASE`, the OTA addresses and build number for api), sets the revision and version labels,
   refuses a tag that is already taken, checks the platform and prints the digest after the push. The build is long —
   run it in the background.
3. **Manifest**: the tag in `03-deployment.yaml` (for the agent — also `APP_VERSION` in `00-config.yaml`); for a
   migration — a new Job file `0N-job-migrate-000N.yaml` modeled on the previous one, with the new `migrate` image.
4. **Diff**: `kubectl diff -f <file>` (exit code 1 = there are differences). Expect exactly the image tag and the
   version; if there is anything else (the live ConfigMap has diverged from the repository), stop and investigate.
5. **Quiet window for the agent**: `kubectl -n agent logs deploy/agent -c agent --since=20m | grep -cE 'socket opened|dialog started'`
   — roll out when it prints zero: the strategy is `Recreate`, live dialogs will be cut off, clients will reconnect.
6. **Migrations first**: `kubectl apply -f k8s/app/db/0N-job-migrate-000N.yaml`,
   `kubectl -n prod wait --for=condition=complete job/app-migrate-000N --timeout=240s`, "applied …" in the Job logs;
   then `kubectl -n prod delete job app-migrate-<previous> --ignore-not-found`.
7. **Services one at a time**: `kubectl apply -f k8s/app/<name>/03-deployment.yaml`,
   `kubectl -n prod rollout status deploy/app-<name> --timeout=300s`. Order for app: migrate → api → web and pwa →
   landing; api must stay compatible with the PWA that is already rolled out.
8. **Verification**: the digest in `kubectl -n prod get pod -l app=app-<name> -o jsonpath='{.items[0].status.containerStatuses[*].imageID}'`
   (for the agent `-n agent -l app=agent`) matches the pushed one; the startup log and errors — skill `logs`; from
   outside `curl -sI https://xn----htbtgjker8b3a2c.xn--p1ai/api/health`, `/app`, `/pwa/`, `/admin/` (redirect to login).
9. **Post-deploy checks** on the test account — `k8s/postdeploy` ([README](../../../k8s/postdeploy/README.md)):
   `POSTDEPLOY_BASELINE=<snapshot> uv run --no-project --with requests --with websocket-client --with pytest python -m pytest -q -p no:cacheprovider --expect post`
   (the snapshot with the test account credentials is kept locally by the administrator; `EXPECT_MEMORY_MODE=on` when
   memory is enabled).
10. **PR** with the `git diff` of the manifests, the digest and the check results; for a large rollout —
    `k8s/agent/RUNBOOK-x.y.z.md`.

## Config and secrets

- **ConfigMap** (`k8s/app/00-app-config.yaml`, `k8s/agent/00-config.yaml`): `kubectl diff` first. If the cluster has
  values that are not in the repository, do not overwrite them wholesale — edit only your own keys
  (`kubectl -n prod patch configmap app-config --type merge --patch-file <file>`) and bring the discrepancy back into
  the repository in a separate PR. The config is read at startup: after an edit run
  `kubectl -n <ns> rollout restart deploy/<name>`.
- **Secret** — create only: `kubectl -n <ns> create secret generic <name> --from-env-file=<file>`; the administrator
  supplies the values, they never appear in the command line, the output or the repository. Before creating — run
  `--dry-run=server -o name`. Replacing an existing one — only with a separate explicit "yes" from the user naming the
  Secret, the namespace and the keys. Which Secrets and keys are needed — see the tables in k8s/README.md and
  k8s/agent/README.md.

## Rollback

- Image: `kubectl -n <ns> rollout undo deploy/<name>` or
  `kubectl -n <ns> set image deploy/<name> <container>=<previous image>` (for the agent restore `APP_VERSION` too), then
  `rollout status`.
- ConfigMap — the previous version from git, `apply` or `patch`, `rollout restart`.
- Database migrations are not rolled back: before a schema that the previous image does not understand — a backup
  (skill `backup`) and a separate plan in the runbook.

## Pitfalls

- **`ImagePullBackOff` with `no match for platform`** — the image was not built for `linux/amd64` (for example, on a
  Mac without `--platform`). The build script checks this; do not overwrite a tag that was already pushed — use the next
  tag and roll the pod back.
- **Push with attestations** fails in this registry with "Permission denied" — hence `--provenance=false --sbom=false`
  and the separate `build --load` and `push`.
- **Building from `/mnt/c` in WSL** hangs on `node_modules` and drags in CRLF — hence the context from `git archive`.
- **A network failure ≠ "no resource".** A TLS timeout to the cluster API or the registry (happens behind a VPN) does
  not mean the Secret or the image does not exist: do not create anything "instead".
- **`kubectl auth can-i`** lies on subresources (`pods/portforward`, `pods/exec`) — check by actually doing it.
- **Public repository.** In commits, PRs, manifests and runbooks — no internal node addresses, no payment account names,
  no secret values or how secrets are stored ("kept locally by the administrator").

Related: [[logs]] — verification after a rollout; [[backup]] — before a schema migration; [[commit]] — branch and PR.
