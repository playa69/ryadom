# syntax=docker/dockerfile:1
# Image for the PWA: the browser build of apps/mobile, served by nginx. The API no longer serves it.
# The build context is the repository root:
#   node scripts/docker.mjs build -f apps/mobile/Dockerfile -t ryadom-pwa:local --build-arg PWA_BASE_PATH=/pwa .
#
# build   installs apps/mobile with the workspace packages it imports and runs `vite build --mode web`;
# runtime puts the result into nginx (nginx/), which also does what the API's lib/pwa.ts used to do.
#
# The client calls the API on its own origin (apiBase is empty, the WebSocket URL comes from
# window.location), so whatever publishes this image has to route `/api` of the same host to the API.
#
# Runtime config, read on every container start (nginx/entrypoint.sh), so one image serves staging and prod:
#   PUBLIC_WEB_URL  the marketing site, where the legal documents live
#   APP_ENV         local | staging | prod
#
# The one thing that is NOT runtime config is the URL prefix: Vite writes it into every asset URL, the
# manifest scope and the service worker scope, so the image is built for the place it is published at:
#   --build-arg PWA_BASE_PATH=/pwa   published at https://<domain>/pwa/ (health: /healthz)
#   (no argument)                    published at the root of its own host

FROM node:24-alpine AS build
ENV CI=true
WORKDIR /repo

COPY package.json ./
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" --no-audit --no-fund

COPY . .
# "..." pulls in the workspace packages the app imports (client-core, contracts, design).
RUN --mount=type=cache,id=ryadom-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@ryadom/mobile..."
ARG PWA_BASE_PATH=""
# The web build needs no VITE_* variables: the API is the same origin and the rest arrives at runtime.
RUN PWA_BASE="$PWA_BASE_PATH" pnpm --filter @ryadom/mobile build:pwa


FROM nginxinc/nginx-unprivileged:1.30-alpine-slim AS runtime
USER root
ARG PWA_BASE_PATH=""

# nginx uses the prefix verbatim in location and map patterns, so it has to be canonical: no trailing
# slash, nothing exotic. Vite's own check is looser, so fail here rather than in a running container.
# (printf adds the newline: an empty value must still be one empty line for grep to match.)
RUN printf '%s\n' "$PWA_BASE_PATH" | grep -Eq '^(/[A-Za-z0-9_-]+)*$' \
    || { echo "PWA_BASE_PATH must be empty or look like /pwa (no trailing slash), got '$PWA_BASE_PATH'" >&2; exit 1; }

# The directory tree mirrors the URL, so a plain `root` works and the prefix needs no rewriting. The
# original index.html is kept apart and removed from the served tree: only the copy with the injected
# meta tags (written at start by entrypoint.sh) may ever be sent.
COPY --from=build /repo/apps/mobile/dist/pwa/ /srv/pwa-static${PWA_BASE_PATH}/
COPY --from=build /repo/apps/mobile/dist/pwa/index.html /srv/pwa-index.html
RUN rm "/srv/pwa-static${PWA_BASE_PATH}/index.html"

# The config is rendered once, at build time, because the prefix is fixed here as well. Lines marked
# "#prefix# " exist only for a non-empty prefix.
COPY apps/mobile/nginx/nginx.conf.template /tmp/nginx.conf.template
RUN if [ -n "$PWA_BASE_PATH" ]; then \
        sed -e "s|@BASE@|$PWA_BASE_PATH|g" -e 's|^#prefix# ||' /tmp/nginx.conf.template; \
    else \
        sed -e 's|@BASE@||g' -e '/^#prefix# /d' /tmp/nginx.conf.template; \
    fi > /etc/nginx/nginx.conf \
    && rm /tmp/nginx.conf.template \
    # An empty hook: docker-compose mounts a dev-only /api proxy here, the image itself has none.
    && mkdir -p /etc/nginx/dev.d

COPY apps/mobile/nginx/pwa-shell.inc /etc/nginx/pwa-shell.inc
# --chmod: the executable bit must not depend on file modes of the machine the image is built on.
COPY --chmod=0755 apps/mobile/nginx/entrypoint.sh /usr/local/bin/pwa-entrypoint.sh

# Not `nginx -t` here: it would create root-owned temp directories under /tmp in the image.
USER 101
EXPOSE 3004
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3004/healthz > /dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/pwa-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
