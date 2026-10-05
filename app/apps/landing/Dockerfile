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

COPY . .
RUN --mount=type=cache,id=ryadom-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ryadom/landing..."
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
