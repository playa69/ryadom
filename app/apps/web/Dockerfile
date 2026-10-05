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

COPY . .
# "..." pulls in the workspace packages the app imports (client-core, contracts, design).
RUN --mount=type=cache,id=ryadom-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ryadom/web..."
ARG BASE_PATH=""
ENV BASE_PATH=$BASE_PATH
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
