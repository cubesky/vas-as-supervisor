#!/bin/sh
# Prepares /data so OpenResty can start with the last known good revision
# (or an empty one on first boot) before the agent pulls a fresh bundle.
set -eu
DATA="${VAS_OPENRESTY_DATA:-/data}"
mkdir -p "$DATA"
if [ ! -e "$DATA/live" ]; then
  mkdir -p "$DATA/rev-0/http" "$DATA/rev-0/stream" "$DATA/rev-0/lua" "$DATA/rev-0/certs"
  ln -sfn rev-0 "$DATA/live"
fi
# a broken live link (e.g. revision dir deleted) would make nginx fail to start
if ! openresty -t >/dev/null 2>&1; then
  echo "vas: current revision fails config test, starting with an empty revision" >&2
  mkdir -p "$DATA/rev-0/http" "$DATA/rev-0/stream" "$DATA/rev-0/lua" "$DATA/rev-0/certs"
  # -n replaces the existing link itself instead of creating one inside its target (BusyBox has no mv -T)
  ln -sfn rev-0 "$DATA/live"
fi
exec "$@"
