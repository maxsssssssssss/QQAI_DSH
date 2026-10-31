#!/usr/bin/env bash
# New QQAI_DSH runtime only. Does not install SnowLuma or open network ports.
set -euo pipefail
umask 077
test "$(id -u)" -eq 0 || { echo 'Run as root on the confirmed target host.' >&2; exit 1; }
. /etc/os-release
test "$ID" = ubuntu
case "$VERSION_ID" in 24.04|26.04) ;; *) echo 'Unreviewed Ubuntu version' >&2; exit 1 ;; esac
test "$(uname -m)" = x86_64
if systemctl is-active --quiet qqai-dsh.service; then
  echo 'Stop qqai-dsh before reinstalling its runtime.' >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils python3 git fontconfig fonts-noto-cjk fonts-noto-color-emoji docker.io docker-compose-v2

if ! id dsh >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /srv/qqai-dsh/home --create-home --shell /usr/sbin/nologin dsh
fi
install -d -m 0700 -o dsh -g dsh /srv/qqai-dsh/home /srv/qqai-dsh/home/.dsh /srv/qqai-dsh/workspace /srv/qqai-dsh/backups
install -d -m 0755 /opt/qqai-dsh
install -d -m 0700 /etc/qqai-dsh
if test ! -x /opt/qqai-dsh/node-v24.22.2-linux-x64/bin/node; then
  stage=$(mktemp -d /opt/qqai-dsh/node-stage.XXXXXX)
  trap 'rm -rf -- "$stage"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz -o "$stage/node.tar.xz"
  printf '%s  %s\n' 48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75 "$stage/node.tar.xz" | sha256sum --check
  tar -xJf "$stage/node.tar.xz" -C /opt/qqai-dsh
  chmod -R a+rX /opt/qqai-dsh/node-v24.22.2-linux-x64
fi
install -d -m 0755 -o dsh -g dsh /opt/qqai-dsh/app
task_lock_dir=''
if [[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]]; then
  task_lock_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/locks" && pwd)
fi
cd /tmp
if [[ -n "$task_lock_dir" && -f "$task_lock_dir/package-lock.json" ]]; then
  install -m 0600 -o dsh -g dsh "$task_lock_dir/package.json" "$task_lock_dir/package-lock.json" /opt/qqai-dsh/app/
  runuser -u dsh -- env PATH=/opt/qqai-dsh/node-v24.22.2-linux-x64/bin:/usr/bin:/bin \
    npm ci --prefix /opt/qqai-dsh/app --ignore-scripts --no-fund --no-audit
else
  runuser -u dsh -- env PATH=/opt/qqai-dsh/node-v24.22.2-linux-x64/bin:/usr/bin:/bin \
    npm install --prefix /opt/qqai-dsh/app --ignore-scripts --save-exact --no-fund --no-audit @deepseek-ai/dsh@0.2.1-rc.5
fi
systemctl enable --now docker
printf 'QQAI_DSH host dependencies installed; no gateway or DSH service started.\n'
/opt/qqai-dsh/node-v24.22.2-linux-x64/bin/node --version
docker --version
docker compose version
