# syntax=docker/dockerfile:1
# The migrate image: a one-shot container that applies migrations before admin and app start.
# The build context is the repository root:
#   docker build -f packages/db/Dockerfile -t ryadom-migrate .
# DATABASE_URL is required when running it; a non-zero exit code means the migration was not applied.

FROM node:24-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@12.6.0
# Manifests only at first, so the dependency layer stays cached while they do not change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter @ryadom/db
COPY tsconfig.base.json ./
COPY packages/db packages/db
RUN pnpm --filter @ryadom/db build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /repo/packages/db/dist/migrate.mjs ./migrate.mjs
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
USER node
CMD ["node", "migrate.mjs"]
