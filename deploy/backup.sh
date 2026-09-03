#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
"$script_dir/assert-isolation.sh"
cd "$script_dir"

stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
umask 077
archive="backups/runtime-data-$stamp.tar.gz"
temporary="$archive.tmp"
trap 'rm -f "$temporary"' EXIT HUP INT TERM

attempt=1
while ! tar -czf "$temporary" runtime-data; do
    rm -f "$temporary"
    if [ "$attempt" -ge 5 ]; then
        printf '%s\n' "Runtime data kept changing; backup failed after $attempt attempts." >&2
        exit 1
    fi
    attempt=$((attempt + 1))
    sleep 1
done
tar -tzf "$temporary" >/dev/null
mv "$temporary" "$archive"
chmod 600 "$archive"
find backups -type f -name 'runtime-data-*.tar.gz' -mtime +30 -delete
printf '%s\n' "$archive"
