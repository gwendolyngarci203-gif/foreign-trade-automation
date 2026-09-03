#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ "$#" -ne 1 ]; then
    printf '%s\n' "Usage: $0 backups/runtime-data-YYYYMMDD-HHMMSS.tar.gz" >&2
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
