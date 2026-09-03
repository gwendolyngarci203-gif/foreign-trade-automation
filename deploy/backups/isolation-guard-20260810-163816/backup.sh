#!/bin/sh
set -eu

cd "$(dirname "$0")"

stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
umask 077
archive="backups/runtime-data-$stamp.tar.gz"
temporary="$archive.tmp"

tar -czf "$temporary" runtime-data
tar -tzf "$temporary" >/dev/null
mv "$temporary" "$archive"
chmod 600 "$archive"
find backups -type f -name 'runtime-data-*.tar.gz' -mtime +30 -delete
printf '%s\n' "$archive"
