# syntax=docker/dockerfile:1
# Image for web: the signed-in web app. Screens are client components that talk to the
# API from the browser, so this server only renders the shell and sets the security headers.
# The build context is the repository root:
#   node scripts/docker.mjs build -f apps/web/Dockerfile -t ryadom-web:local .
#
# No database, no core package and no secrets. The two addresses it needs are runtime config, read
# on every request (apps/web/.env.example), so one image serves staging and prod:
#   PUBLIC_API_URL  the API the browser connects to (also the only extra origin the CSP allows)
#   PUBLIC_WEB_URL  the marketing site, where the terms and privacy documents live
#
# The one thing that is NOT runtime config is the URL prefix: Next fixes basePath at build time, so
# the image is built for the place it is published at:
#   --build-arg BASE_PATH=/app       published at https://<domain>/app (health: /app/api/health)
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
# "..." pulls in the workspace packages the app imports (client-core, contracts, design).
RUN --mount=type=cache,id=ryadom-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ryadom/web..."
COPY . .
ARG BASE_PATH=""
ENV BASE_PATH=$BASE_PATH
# The image tag, reported to analytics as app_version (--build-arg RELEASE=0.6.0); empty falls back to package.json.
ARG RELEASE=""
ENV RELEASE=$RELEASE
RUN pnpm --filter @ryadom/web build


FROM node:24-alpine AS runtime
ARG BASE_PATH=""
ENV NODE_ENV=production \
    PORT=3003 \
    HOSTNAME=0.0.0.0 \
    BASE_PATH=$BASE_PATH
WORKDIR /app

# Next standalone output: the server plus only the modules it actually imports.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone/ ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static/ ./apps/web/.next/static/
COPY --from=build --chown=node:node /repo/apps/web/public/ ./apps/web/public/

USER node
EXPOSE 3003
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}${BASE_PATH}/api/health" > /dev/null || exit 1
CMD ["node", "apps/web/server.js"]
