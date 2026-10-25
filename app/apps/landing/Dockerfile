# syntax=docker/dockerfile:1
# Image for landing: the landing page and the legal pages.
# The build context is the repository root:
#   node scripts/docker.mjs build -f apps/landing/Dockerfile -t ryadom-landing:local .
#
# The site has no database, no core package and no secrets, so this is the simplest of the five images.

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
    pnpm install --frozen-lockfile --filter "@ryadom/landing..."
COPY . .
# The image tag, reported to analytics as app_version (--build-arg RELEASE=0.3.3); empty falls back to package.json.
ARG RELEASE=""
ENV RELEASE=$RELEASE
RUN pnpm --filter @ryadom/landing build


FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# Next standalone output: the server plus only the modules it actually imports.
COPY --from=build --chown=node:node /repo/apps/landing/.next/standalone/ ./
COPY --from=build --chown=node:node /repo/apps/landing/.next/static/ ./apps/landing/.next/static/
COPY --from=build --chown=node:node /repo/apps/landing/public/ ./apps/landing/public/

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1
CMD ["node", "apps/landing/server.js"]
