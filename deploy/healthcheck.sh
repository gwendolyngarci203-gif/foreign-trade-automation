#!/bin/sh
set -eu

base_dir=${OPS_BASE_DIR:-/opt/dakings-prospect-ops}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
"$script_dir/assert-isolation.sh" >/dev/null
health_url=${OPS_HEALTH_URL:-http://127.0.0.1:4173/api/health}
disk_warn_percent=${OPS_DISK_WARN_PERCENT:-85}
memory_warn_percent=${OPS_MEMORY_WARN_PERCENT:-90}
backup_max_age_seconds=${OPS_BACKUP_MAX_AGE_SECONDS:-129600}
runtime_dir="$base_dir/deploy/runtime-data"
backup_dir="$base_dir/deploy/backups"
status_file="$runtime_dir/ops-health.json"
status_tmp="$status_file.tmp.$$"
failures=""

append_failure() {
    if [ -n "$failures" ]; then
        failures="$failures; $1"
    else
        failures=$1
    fi
}

umask 077
mkdir -p "$runtime_dir"

if ! systemctl is-active --quiet dakings-prospect-ops.service; then
    append_failure "application service is not active"
fi
if ! systemctl is-active --quiet nginx.service; then
    append_failure "nginx service is not active"
fi

listener=$(ss -lntH | awk '$4 ~ /:4173$/ { print $4; exit }')
case "$listener" in
    127.0.0.1:4173|\[::1\]:4173) ;;
    "") append_failure "port 4173 is not listening" ;;
    *) append_failure "port 4173 is not loopback-only" ;;
esac

health_json=""
if health_json=$(curl -fsS --max-time 10 "$health_url"); then
    expected_sending=$(awk -F= '$1 == "EMAIL_SENDING_ENABLED" { value=tolower($2) } END { print value == "true" ? "true" : "false" }' "$base_dir/deploy/.env.runtime")
    if ! printf '%s' "$health_json" | OPS_EXPECTED_SENDING="$expected_sending" /usr/bin/node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const data = JSON.parse(input);
  const expectedSending = process.env.OPS_EXPECTED_SENDING === "true";
  const valid = data.ok === true
    && data.sourceLoaded === true
    && data.ai?.configured === true
    && data.ai?.model === "gpt-5.6-sol"
    && data.delivery?.allowUnverified === false
    && data.sendingEnabled === expectedSending;
  process.exit(valid ? 0 : 1);
});
'; then
        append_failure "health payload failed the production safety contract"
    fi
else
    append_failure "application health endpoint is unavailable"
fi

# Verify the browser-facing shell and its primary data contract separately from
# /api/health so a broken asset or malformed dashboard response is not hidden.
frontend_check_dir=$(mktemp -d "$runtime_dir/frontend-check.XXXXXX")
trap 'rm -rf "$frontend_check_dir"' EXIT
curl -fsS --max-time 10 -o "$frontend_check_dir/index.html" http://127.0.0.1:4173/ || true
curl -fsS --max-time 10 -o "$frontend_check_dir/app.js" http://127.0.0.1:4173/app.js || true
curl -fsS --max-time 10 -o "$frontend_check_dir/styles.css" http://127.0.0.1:4173/styles.css || true
if ! FRONTEND_DIR="$frontend_check_dir" /usr/bin/node -e '
const fs = require("fs");
const dir = process.env.FRONTEND_DIR;
const html = fs.readFileSync(`${dir}/index.html`, "utf8");
const js = fs.readFileSync(`${dir}/app.js`, "utf8");
const css = fs.readFileSync(`${dir}/styles.css`, "utf8");
const valid = /<!doctype html/i.test(html) && /class="app-shell"/i.test(html) && js.length > 1000 && css.length > 1000;
process.exit(valid ? 0 : 1);
'; then
    append_failure "frontend shell or static assets failed validation"
fi

if ! inventory_json=$(curl -fsS --max-time 10 'http://127.0.0.1:4173/api/pipeline/inventory?limit=1'); then
    append_failure "pipeline inventory endpoint is unavailable"
elif ! printf '%s' "$inventory_json" | /usr/bin/node -e '
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    const valid = Number.isFinite(Number(data.selectedCompanyCount))
      && Number.isFinite(Number(data.draftPool?.remaining))
      && ["collecting", "drafting", "sending", "aborted", "ended", "circuit_open", "interrupted"].includes(String(data.dailyStatus?.code || ""));
    process.exit(valid ? 0 : 1);
  } catch { process.exit(1); }
});
'; then
    append_failure "pipeline inventory response failed validation"
fi

https_status=$(curl -k -sS --max-time 10 -o /dev/null -w '%{http_code}' https://127.0.0.1/ || true)
if [ "$https_status" != "401" ]; then
    append_failure "local unauthenticated HTTPS did not return 401"
fi

disk_percent=$(df -P "$base_dir" | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')
case "$disk_percent" in
    ''|*[!0-9]*) append_failure "disk usage could not be measured" ;;
    *)
        if [ "$disk_percent" -ge "$disk_warn_percent" ]; then
            append_failure "disk usage reached ${disk_percent}%"
        fi
        ;;
esac

memory_percent=$(awk '
/^MemTotal:/ { total=$2 }
/^MemAvailable:/ { available=$2 }
END {
  if (total > 0 && available >= 0) {
    printf "%d", ((total - available) * 100) / total
  }
}
' /proc/meminfo)
case "$memory_percent" in
    ''|*[!0-9]*) append_failure "memory usage could not be measured" ;;
    *)
        if [ "$memory_percent" -ge "$memory_warn_percent" ]; then
            append_failure "memory usage reached ${memory_percent}%"
        fi
        ;;
esac

backup_age_seconds=-1
latest_backup=$(find "$backup_dir" -maxdepth 1 -type f -name 'runtime-data-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2- || true)
if [ -z "$latest_backup" ]; then
    append_failure "no runtime backup exists"
else
    latest_epoch=$(stat -c %Y "$latest_backup")
    now_epoch=$(date +%s)
    backup_age_seconds=$((now_epoch - latest_epoch))
    if [ "$backup_age_seconds" -gt "$backup_max_age_seconds" ]; then
        append_failure "latest runtime backup is older than the allowed window"
    fi
    if ! tar -tzf "$latest_backup" >/dev/null; then
        append_failure "latest runtime backup failed integrity validation"
    fi
fi

if [ -n "$failures" ]; then
    state=failed
else
    state=ok
fi

OPS_STATUS_PATH="$status_tmp" \
OPS_STATE="$state" \
OPS_CHECKED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
OPS_DISK_PERCENT="$disk_percent" \
OPS_MEMORY_PERCENT="$memory_percent" \
OPS_BACKUP_AGE_SECONDS="$backup_age_seconds" \
OPS_FAILURES="$failures" \
/usr/bin/node <<'NODE'
const fs = require("fs");
const failures = process.env.OPS_FAILURES
  ? process.env.OPS_FAILURES.split("; ").filter(Boolean)
  : [];
const result = {
  schemaVersion: 1,
  state: process.env.OPS_STATE,
  checkedAt: process.env.OPS_CHECKED_AT,
  checks: {
    applicationHealth: failures.every(item => !item.includes("health")),
    localHttpsAuth: failures.every(item => !item.includes("HTTPS")),
    loopbackOnly: failures.every(item => !item.includes("4173")),
    diskUsedPercent: Number(process.env.OPS_DISK_PERCENT || -1),
    memoryUsedPercent: Number(process.env.OPS_MEMORY_PERCENT || -1),
    backupAgeSeconds: Number(process.env.OPS_BACKUP_AGE_SECONDS || -1)
  },
  failures
};
fs.writeFileSync(process.env.OPS_STATUS_PATH, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
NODE

mv "$status_tmp" "$status_file"
chmod 600 "$status_file"
chown prospectops:prospectops "$status_file"

if [ "$state" != "ok" ]; then
    printf '%s\n' "Health check failed: $failures" >&2
    exit 1
fi

printf '%s\n' "Health check passed: disk=${disk_percent}% memory=${memory_percent}% backup_age=${backup_age_seconds}s"
