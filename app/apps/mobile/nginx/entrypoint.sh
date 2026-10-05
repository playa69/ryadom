#!/bin/sh
# Entry point of the PWA image: renders the shell, then starts nginx.
#
# One image serves staging and prod, so the site address and the environment are not baked into the
# build. Every time the container starts, the two meta tags that the client reads are inserted before
# </head> of the built index.html, and nginx serves the result for every shell response
# (nginx.conf.template, pwa-shell.inc). The meta names are PwaMeta in packages/contracts/src/pwa.ts;
# apps/mobile/src/client/lib/env.ts reads them.
#
#   PUBLIC_WEB_URL  origin of the website, where the legal documents are (https://example.com)
#   APP_ENV         local | staging | prod
#
# The root filesystem is read-only in k8s, so the result goes to /tmp (an emptyDir there).
set -eu

fail() {
  echo "pwa: $1" >&2
  exit 1
}

: "${PUBLIC_WEB_URL:?PUBLIC_WEB_URL is required, for example https://example.com}"
: "${APP_ENV:?APP_ENV is required: local, staging or prod}"

case "$APP_ENV" in
  local | staging | prod) ;;
  *) fail "APP_ENV must be local, staging or prod, got '$APP_ENV'" ;;
esac

case "$PUBLIC_WEB_URL" in
  http://* | https://*) ;;
  *) fail "PUBLIC_WEB_URL must start with http:// or https://, got '$PUBLIC_WEB_URL'" ;;
esac
case "$PUBLIC_WEB_URL" in
  *[[:space:]]*) fail "PUBLIC_WEB_URL must not contain whitespace" ;;
esac

# The values come from the deployment, but they land inside an HTML attribute, so escape them anyway.
escape_attribute() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/"/\&quot;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

web_url=$(escape_attribute "$(printf '%s' "$PUBLIC_WEB_URL" | sed 's|/*$||')")
app_env=$(escape_attribute "$APP_ENV")

meta="<meta name=\"ryadom-web-url\" content=\"${web_url}\"><meta name=\"ryadom-app-env\" content=\"${app_env}\">"

marker='</head>'
html=$(cat /srv/pwa-index.html)
case "$html" in
  *"$marker"*) ;;
  *) fail "no $marker in the built index.html" ;;
esac

# Plain parameter expansion, no sed or awk over the value: nothing in it can be taken for a pattern.
mkdir -p /tmp/pwa-shell
printf '%s%s%s%s\n' "${html%%"$marker"*}" "$meta" "$marker" "${html#*"$marker"}" > /tmp/pwa-shell/index.html.tmp
# Written next to the target and renamed, so a restart of the container never leaves half a file.
mv /tmp/pwa-shell/index.html.tmp /tmp/pwa-shell/index.html

exec "$@"
