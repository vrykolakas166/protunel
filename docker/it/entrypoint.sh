#!/bin/sh
set -eu
ssh-keygen -A
if [ "${SERVE_HTTP:-0}" = 1 ]; then
    python3 -m http.server 8080 --bind 0.0.0.0 --directory /srv/http &
fi
exec /usr/sbin/sshd -D -e
