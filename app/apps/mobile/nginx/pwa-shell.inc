# Serves the shell: the rendered index.html from /tmp/pwa-shell (written by entrypoint.sh).
# After the rewrite $uri is /index.html, so the shell gets Cache-Control: no-cache from the map.
root /tmp/pwa-shell;
rewrite ^ /index.html break;
