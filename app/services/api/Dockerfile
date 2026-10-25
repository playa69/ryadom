# syntax=docker/dockerfile:1
# The API image: REST, the WebSocket gateway to the agent, and OTA bundle serving.
# The build context is the repository root:
#   node scripts/docker.mjs build -f services/api/Dockerfile -t ryadom-api:local .
#
# build   installs the API and apps/mobile (the native OTA bundles are built from its client, one
#         image, one version), then bundles the API (esbuild) and both native OTA bundles (vite, zipped);
# runtime keeps only the bundles and the native dependencies that stay out of the bundle (argon2).
#
# The PWA is not here: it is the browser build of the same client, and it has its own image
# (apps/mobile/Dockerfile, nginx).

FROM node:24-alpine AS build
ENV CI=true
WORKDIR /repo

# The pnpm version comes from packageManager in the root package.json, the same one developers use.
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
    pnpm install --frozen-lockfile --filter "@ryadom/api..." --filter "@ryadom/mobile..."
COPY . .
RUN pnpm --filter @ryadom/api build

# OTA: both native flavours, zipped and checksummed, baked into this same image - no
# bucket, no second pipeline. OTA_BUILD_NUMBER ties the bundle version to this build; empty here
# is fine for a local or CI check build, where nothing downloads the result. `zip` keeps forward
# slashes in the archive, which the update plugin on the device requires.
ARG OTA_BUILD_NUMBER
# The image tag; the native bundles report it to analytics as app_version, the server reads it at run time too.
ARG RELEASE=""
ARG VITE_PROD_API_URL
ARG VITE_PROD_WEB_URL
ARG VITE_STAGING_API_URL
ARG VITE_STAGING_WEB_URL
# apps/mobile's vite.config.ts and build-ota-bundle.mjs read these from process.env, so a build
# ARG must become an ENV before it reaches the RUN step below.
ENV RELEASE=$RELEASE \
    OTA_BUILD_NUMBER=$OTA_BUILD_NUMBER \
    VITE_PROD_API_URL=$VITE_PROD_API_URL \
    VITE_PROD_WEB_URL=$VITE_PROD_WEB_URL \
    VITE_STAGING_API_URL=$VITE_STAGING_API_URL \
    VITE_STAGING_WEB_URL=$VITE_STAGING_WEB_URL
RUN apk add --no-cache zip
RUN pnpm --filter @ryadom/mobile build:ota


FROM node:24-alpine AS runtime
ARG RELEASE=""
ENV NODE_ENV=production \
    PORT=3002 \
    RELEASE=$RELEASE
WORKDIR /app

# Native modules (argon2) for the image platform, at the versions recorded by the build.
COPY --from=build /repo/services/api/dist/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock \
    && npm cache clean --force

COPY --from=build /repo/services/api/dist/ ./
COPY --from=build /repo/apps/mobile/dist/ota/ ./ota/

USER node
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1
CMD ["node", "--enable-source-maps", "index.js"]
