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

COPY . .
RUN --mount=type=cache,id=ryadom-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ryadom/admin..."
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
