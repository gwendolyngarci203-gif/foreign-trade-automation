#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
"$script_dir/assert-isolation.sh"

systemctl daemon-reload
systemctl enable --now dakings-prospect-ops.service
nginx -t
systemctl enable --now nginx.service
systemctl reload nginx.service
systemctl enable --now dakings-prospect-ops-backup.timer
systemctl enable --now dakings-prospect-ops-healthcheck.timer
systemctl enable --now dakings-imap-feedback.timer
systemctl enable --now dakings-pipeline-worker.timer

attempt=0
until curl -fsS http://127.0.0.1:4173/api/health >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    journalctl -u dakings-prospect-ops.service -n 100 --no-pager
    exit 1
  fi
  sleep 2
done

systemctl --no-pager --full status dakings-prospect-ops.service
curl -fsS http://127.0.0.1:4173/api/health
systemctl start dakings-prospect-ops-healthcheck.service
