# syntax=docker/dockerfile:1
# The API image: REST, the WebSocket gateway to the agent, and PWA/OTA serving.
# The build context is the repository root:
#   node scripts/docker.mjs build -f services/api/Dockerfile -t ryadom-api:local .
#
# build   installs the API and apps/mobile (its client is what the API serves — one image, one
#         version, same reasoning as before the two were split into separate packages), then
#         bundles the API (esbuild), the PWA (vite) and both native OTA bundles (vite, zipped);
# runtime keeps only the bundles and the native dependencies that stay out of the bundle (argon2).

FROM node:24-alpine AS build
ENV CI=true
WORKDIR /repo

# The pnpm version comes from packageManager in the root package.json, the same one developers use.
COPY package.json ./
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" --no-audit --no-fund

COPY . .
RUN --mount=type=cache,id=ryadom-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ryadom/api..." --filter "@ryadom/mobile..."
RUN pnpm --filter @ryadom/api build
# The PWA is apps/mobile's client with a different build target; the API serves it itself
# (lib/pwa.ts), so it ships in this same image — apps/mobile has no runtime image of its own.
#
# PWA_BASE_PATH is where the PWA sits on the host (`/pwa` when the host is shared with a landing
# page and other apps; empty when the PWA owns the root). The build writes it into every asset URL,
# the service worker scope and the manifest, and the runtime stage gives the same value to the
# server, which then answers only under it. It is NOT part of the OTA/native bundles below: those
# run from the WebView root.
ARG PWA_BASE_PATH=""
RUN PWA_BASE="$PWA_BASE_PATH" pnpm --filter @ryadom/mobile build:pwa

# OTA: both native flavours, zipped and checksummed, baked into this same image - no
# bucket, no second pipeline. OTA_BUILD_NUMBER ties the bundle version to this build; empty here
# is fine for a local or CI check build, where nothing downloads the result. `zip` keeps forward
# slashes in the archive, which the update plugin on the device requires.
ARG OTA_BUILD_NUMBER
ARG VITE_PROD_API_URL
ARG VITE_PROD_WEB_URL
ARG VITE_STAGING_API_URL
ARG VITE_STAGING_WEB_URL
# apps/mobile's vite.config.ts and build-ota-bundle.mjs read these from process.env, so a build
# ARG must become an ENV before it reaches the RUN step below.
ENV OTA_BUILD_NUMBER=$OTA_BUILD_NUMBER \
    VITE_PROD_API_URL=$VITE_PROD_API_URL \
    VITE_PROD_WEB_URL=$VITE_PROD_WEB_URL \
    VITE_STAGING_API_URL=$VITE_STAGING_API_URL \
    VITE_STAGING_WEB_URL=$VITE_STAGING_WEB_URL
RUN apk add --no-cache zip
RUN pnpm --filter @ryadom/mobile build:ota


FROM node:24-alpine AS runtime
ARG PWA_BASE_PATH=""
ENV NODE_ENV=production \
    PORT=3002 \
    PWA_BASE_PATH=$PWA_BASE_PATH
WORKDIR /app

# Native modules (argon2) for the image platform, at the versions recorded by the build.
COPY --from=build /repo/services/api/dist/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock \
    && npm cache clean --force

COPY --from=build /repo/services/api/dist/ ./
COPY --from=build /repo/apps/mobile/dist/pwa/ ./pwa/
COPY --from=build /repo/apps/mobile/dist/ota/ ./ota/

USER node
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1
CMD ["node", "--enable-source-maps", "index.js"]
