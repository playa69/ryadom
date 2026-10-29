#!/bin/sh
# Entry point of the PWA image: renders the shell, then starts nginx.
#
# One image serves the local stack and prod, so the site address is not baked into the build. Every
# time the container starts, the meta tag that the client reads is inserted before </head> of the built
# index.html, and nginx serves the result for every shell response (nginx.conf.template,
# pwa-shell.inc). The meta name is PwaMeta in packages/contracts/src/pwa.ts;
# apps/mobile/src/client/lib/env.ts reads it.
#
#   PUBLIC_WEB_URL  origin of the website, where the legal documents are (https://example.com)
#
# The root filesystem is read-only in k8s, so the result goes to /tmp (an emptyDir there).
set -eu

fail() {
  echo "pwa: $1" >&2
  exit 1
}

: "${PUBLIC_WEB_URL:?PUBLIC_WEB_URL is required, for example https://example.com}"

case "$PUBLIC_WEB_URL" in
  http://* | https://*) ;;
  *) fail "PUBLIC_WEB_URL must start with http:// or https://, got '$PUBLIC_WEB_URL'" ;;
esac
case "$PUBLIC_WEB_URL" in
  *[[:space:]]*) fail "PUBLIC_WEB_URL must not contain whitespace" ;;
esac

# The value comes from the deployment, but it lands inside an HTML attribute, so escape it anyway.
escape_attribute() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/"/\&quot;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

web_url=$(escape_attribute "$(printf '%s' "$PUBLIC_WEB_URL" | sed 's|/*$||')")

meta="<meta name=\"ryadom-web-url\" content=\"${web_url}\">"

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
