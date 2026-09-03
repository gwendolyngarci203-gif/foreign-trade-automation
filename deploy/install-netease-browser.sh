#!/bin/sh
set -eu

base_dir=/opt/dakings-prospect-ops
runtime_dir="$base_dir/browser-runtime"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
"$script_dir/assert-isolation.sh"

if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab

dnf install -y chromium xorg-x11-server-Xvfb glibc-langpack-zh >/dev/null
install -d -m 700 -o prospectops -g prospectops "$runtime_dir" "$runtime_dir/home" "$runtime_dir/profile"
if [ ! -d "$runtime_dir/node_modules/playwright-core" ] || [ ! -d "$runtime_dir/node_modules/ws" ]; then
  runuser -u prospectops -- env HOME="$runtime_dir/home" npm_config_cache="$runtime_dir/home/.npm" \
    npm install --prefix "$runtime_dir" --no-audit --no-fund --omit=dev playwright-core@1.62.1 ws@8.18.3 >/dev/null
fi

install -m 644 "$script_dir/dakings-netease-browser.service" /etc/systemd/system/dakings-netease-browser.service
systemctl daemon-reload
systemctl enable --now dakings-netease-browser.service

attempt=0
until curl -fsS http://127.0.0.1:9224/json/version >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    journalctl -u dakings-netease-browser.service -n 100 --no-pager
    exit 1
  fi
  sleep 2
done

test "$(ss -ltnp 'sport = :9224' | awk 'NR==2 {print $4}')" = "127.0.0.1:9224"
systemctl is-active --quiet dakings-netease-browser.service
printf '%s\n' 'NetEase browser runtime ready on 127.0.0.1:9224'
