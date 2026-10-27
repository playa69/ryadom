#!/usr/bin/env bash
# Builds one image of «Рядом» the way k8s/README.md («Сборка и push образов») describes it, from a commit rather than
# from the working tree: the context is `git archive` of that commit (no node_modules, no local edits, LF endings).
#   build.sh <api|web|admin|landing|pwa|migrate|agent> <tag> [--ref <commit>] [--push]
# Refuses a tag that is already in the registry, checks the image is linux/amd64 (the cluster nodes) and, with --push,
# pushes it and prints its digest. Registry calls (tag check, push) go through RYADOM_DOCKER (default: docker), which
# must be logged in to cr.yandex; the build itself uses the local docker.
set -euo pipefail

service=${1:?usage: build.sh <service> <tag> [--ref <commit>] [--push]}
tag=${2:?usage: build.sh <service> <tag> [--ref <commit>] [--push]}
shift 2
ref=HEAD push=0
while (( $# )); do
    case $1 in
        --ref) ref=${2:?--ref needs a commit}; shift ;;
        --push) push=1 ;;
        *) echo "Unknown argument $1" >&2; exit 2 ;;
    esac
    shift
done
[[ $tag =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || { echo "Tag $tag: use a version like 0.8.2 (never latest)" >&2; exit 2; }

registry=cr.yandex/crpsqeamqpuvrkm5tpr9
origin=https://xn----htbtgjker8b3a2c.xn--p1ai
read -r -a registry_docker <<<"${RYADOM_DOCKER:-docker}"
repo=$(git rev-parse --show-toplevel)
rev=$(git -C "$repo" rev-parse "$ref^{commit}")
args=()
case $service in
    agent)   dir=agent image=$registry/agent/agent:$tag dockerfile=Dockerfile ;;
    migrate) dir=app image=$registry/app/migrate:$tag dockerfile=packages/db/Dockerfile ;;
    landing) dir=app image=$registry/app/landing:$tag dockerfile=apps/landing/Dockerfile args=(--build-arg "RELEASE=$tag") ;;
    web)     dir=app image=$registry/app/web:$tag dockerfile=apps/web/Dockerfile args=(--build-arg BASE_PATH=/app --build-arg "RELEASE=$tag") ;;
    admin)   dir=app image=$registry/app/admin:$tag dockerfile=apps/admin/Dockerfile args=(--build-arg BASE_PATH=/admin) ;;
    pwa)     dir=app image=$registry/app/pwa:$tag dockerfile=apps/mobile/Dockerfile args=(--build-arg PWA_BASE_PATH=/pwa --build-arg "RELEASE=$tag") ;;
    api)     dir=app image=$registry/app/api:$tag dockerfile=services/api/Dockerfile
             args=(--build-arg "VITE_PROD_API_URL=$origin" --build-arg "VITE_PROD_WEB_URL=$origin" --build-arg "RELEASE=$tag"
                   --build-arg "OTA_BUILD_NUMBER=$(git -C "$repo" rev-list --count "$rev")") ;;
    *) echo "Unknown service $service" >&2; exit 2 ;;
esac

# An existing tag is never overwritten: deployments and rollbacks rely on it.
if "${registry_docker[@]}" manifest inspect "$image" >/dev/null 2>&1; then
    echo "$image is already in the registry: pick the next tag" >&2
    exit 1
fi

ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
git -C "$repo" -c core.autocrlf=false archive "$rev" "$dir" | tar -x -C "$ctx"
echo "== $image from ${rev:0:12} ($dir/$dockerfile)"
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --load \
    --label "org.opencontainers.image.revision=$rev" --label "org.opencontainers.image.version=$tag" \
    ${args[@]+"${args[@]}"} -f "$ctx/$dir/$dockerfile" -t "$image" "$ctx/$dir"

platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")
[[ $platform == linux/amd64 ]] || { echo "$image is $platform, the cluster needs linux/amd64" >&2; exit 1; }
if (( push )); then
    "${registry_docker[@]}" push "$image"
    echo "Pushed: $(docker image inspect --format '{{index .RepoDigests 0}}' "$image")"
else
    echo "Built $image ($platform), not pushed: add --push"
fi
