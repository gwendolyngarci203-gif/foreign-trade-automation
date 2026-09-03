#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
"$script_dir/assert-isolation.sh"
cd "$script_dir"

verify_only=0
if [ "${1:-}" = "--verify" ]; then
    verify_only=1
    shift
fi

if [ "$#" -ne 1 ]; then
    printf '%s\n' "Usage: $0 [--verify] backups/runtime-data-YYYYMMDD-HHMMSS.tar.gz" >&2
    exit 2
fi

archive=$1
case "$archive" in
    backups/runtime-data-*.tar.gz) ;;
    *)
        printf '%s\n' "Refusing archive outside deploy/backups." >&2
        exit 2
        ;;
esac

if [ ! -f "$archive" ]; then
    printf '%s\n' "Archive not found: $archive" >&2
    exit 2
fi

tar -tzf "$archive" >/dev/null
case "$(tar -tzf "$archive" | head -n 1)" in
    runtime-data/|runtime-data) ;;
    *)
        printf '%s\n' "Archive does not contain the expected runtime-data root." >&2
        exit 2
        ;;
esac

if [ "$verify_only" -eq 1 ]; then
    verify_dir=$(mktemp -d ./runtime-data.verify.XXXXXX)
    trap 'rm -rf "$verify_dir"' EXIT
    tar -xzf "$archive" -C "$verify_dir"
    test -d "$verify_dir/runtime-data"
    test -f "$verify_dir/runtime-data/pipeline.json"
    test -f "$verify_dir/runtime-data/outbox.json"
    test -f "$verify_dir/runtime-data/runtime-state.json"
    printf '%s\n' "Backup restore verification passed: $archive"
    exit 0
fi

stamp=$(date +%Y%m%d-%H%M%S)
rollback="backups/pre-restore-$stamp.tar.gz"
umask 077
tar -czf "$rollback" runtime-data
tar -tzf "$rollback" >/dev/null
chmod 600 "$rollback"

systemctl stop dakings-prospect-ops.service
rm -rf runtime-data.restore
mkdir runtime-data.restore
tar -xzf "$archive" -C runtime-data.restore

if [ ! -d runtime-data.restore/runtime-data ]; then
    systemctl start dakings-prospect-ops.service
    printf '%s\n' "Restore staging directory is invalid; current data was not changed." >&2
    exit 1
fi

rm -rf runtime-data.previous
mv runtime-data runtime-data.previous
mv runtime-data.restore/runtime-data runtime-data
chown -R prospectops:prospectops runtime-data
systemctl start dakings-prospect-ops.service

attempt=0
until curl -fsS http://127.0.0.1:4173/api/health >/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
        systemctl stop dakings-prospect-ops.service
        rm -rf runtime-data
        mv runtime-data.previous runtime-data
        chown -R prospectops:prospectops runtime-data
        systemctl start dakings-prospect-ops.service
        printf '%s\n' "Health check failed; rollback restored from runtime-data.previous." >&2
        exit 1
    fi
    sleep 2
done

rm -rf runtime-data.previous runtime-data.restore
printf '%s\n' "Restore completed. Pre-restore rollback: $rollback"
