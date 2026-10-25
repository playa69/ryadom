# syntax=docker/dockerfile:1
# Image for admin: users, blocking, account deletion, audit log.
# The build context is the repository root:
#   node scripts/docker.mjs build -f apps/admin/Dockerfile -t ryadom-admin:local .
#
# A separate service: on a host of its own, or on a shared host under a prefix. The prefix is a
# build argument because Next fixes it at build time (basePath):
#   --build-arg BASE_PATH=/admin     published at https://<domain>/admin (health: /admin/api/health)
#   (no argument)                    published at the root of its own host

FROM node:24-alpine AS build
ENV CI=true
WORKDIR /repo

COPY package.json ./
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" --no-audit --no-fund

# Dependencies before the sources: this layer depends only on the lockfile and the manifests, so a code change
# reuses it instead of writing a new node_modules layer (about 1 GB) on every build. Every workspace package's
# manifest is listed so that "..." below resolves exactly as in the repository: a new package goes here too.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/admin/package.json apps/admin/
COPY apps/landing/package.json apps/landing/
COPY apps/mobile/package.json apps/mobile/
COPY apps/web/package.json apps/web/
COPY services/api/package.json services/api/
COPY packages/analytics/package.json packages/analytics/
COPY packages/client-core/package.json packages/client-core/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/design/package.json packages/design/
COPY packages/ui/package.json packages/ui/
COPY dev/agent-mock/package.json dev/agent-mock/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=ryadom-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ryadom/admin..."
COPY . .
ARG BASE_PATH=""
ENV BASE_PATH=$BASE_PATH
RUN pnpm --filter @ryadom/admin build


FROM node:24-alpine AS runtime
ARG BASE_PATH=""
ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0 \
    BASE_PATH=$BASE_PATH
WORKDIR /app

COPY --from=build --chown=node:node /repo/apps/admin/.next/standalone/ ./
COPY --from=build --chown=node:node /repo/apps/admin/.next/static/ ./apps/admin/.next/static/
COPY --from=build --chown=node:node /repo/apps/admin/public/ ./apps/admin/public/

USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}${BASE_PATH}/api/health" > /dev/null || exit 1
CMD ["node", "apps/admin/server.js"]
