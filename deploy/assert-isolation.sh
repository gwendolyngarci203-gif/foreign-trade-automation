#!/bin/sh
set -eu

expected_root=/opt/dakings-prospect-ops
expected_deploy=$expected_root/deploy
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

fail() {
    printf '%s\n' "Isolation check failed: $1" >&2
    exit 1
}

[ "$script_dir" = "$expected_deploy" ] || fail "unexpected deploy directory: $script_dir"
[ "$(readlink -f "$expected_root")" = "$expected_root" ] || fail "project root is redirected"
[ ! -L "$expected_root" ] || fail "project root must not be a symbolic link"
[ ! -L "$expected_root/app" ] || fail "app directory must not be a symbolic link"
[ ! -L "$expected_root/deploy" ] || fail "deploy directory must not be a symbolic link"
[ ! -L "$expected_root/deploy/runtime-data" ] || fail "runtime-data must not be a symbolic link"

for path in \
    "$expected_root/app" \
    "$expected_root/deploy" \
    "$expected_root/deploy/runtime-data"
do
    resolved=$(readlink -f "$path")
    case "$resolved" in
        "$expected_root"/*) ;;
        *) fail "path escapes project root: $path" ;;
    esac
done

if command -v systemctl >/dev/null 2>&1; then
    app_user=$(systemctl show dakings-prospect-ops.service -p User --value)
    app_work=$(systemctl show dakings-prospect-ops.service -p WorkingDirectory --value)
    worker_user=$(systemctl show dakings-pipeline-worker.service -p User --value)
    worker_work=$(systemctl show dakings-pipeline-worker.service -p WorkingDirectory --value)
    [ "$app_user" = prospectops ] || fail "unexpected application service user"
    [ "$app_work" = "$expected_root/app" ] || fail "unexpected application working directory"
    [ "$worker_user" = prospectops ] || fail "unexpected worker service user"
    [ "$worker_work" = "$expected_root" ] || fail "unexpected worker working directory"
fi

printf '%s\n' "Isolation check passed for $expected_root"
