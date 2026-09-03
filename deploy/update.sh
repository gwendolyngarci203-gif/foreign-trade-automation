#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
"$script_dir/assert-isolation.sh"
cd "$script_dir"

test -f .env.runtime
test -f source/source.json
mkdir -p runtime-data/backups

docker compose build --pull
docker compose up -d --remove-orphans
docker compose ps

attempt=0
until wget -qO- http://127.0.0.1/api/health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker compose logs --tail=100
    exit 1
  fi
  sleep 2
done

wget -qO- http://127.0.0.1/api/health
