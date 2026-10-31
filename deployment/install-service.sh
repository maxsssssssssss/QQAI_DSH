#!/usr/bin/env bash
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
source_dir=/opt/qqai-dsh/source
test -f "$source_dir/deployment/run-dsh.py"
runuser -u dsh -- test -r "$source_dir/deployment/run-dsh.py"
test -f /etc/qqai-dsh/deepseek-api-key
test "$(stat -c '%U:%G:%a' /etc/qqai-dsh/deepseek-api-key)" = root:root:600
case " $(id -nG dsh) " in *' docker '*|*' sudo '*) echo 'dsh must not have Docker or sudo group access' >&2; exit 1 ;; esac
runuser -u dsh -- /opt/qqai-dsh/node-v24.22.2-linux-x64/bin/node \
  "$source_dir/scripts/patch-plugin-media.mjs" --check \
  /srv/qqai-dsh/home/.dsh/profiles/web/node_modules/dsh-aurabot-qq \
  /srv/qqai-dsh/home/.dsh/profiles/web/node_modules/dsh-nekowhale-stickers
install -m 0644 "$source_dir/deployment/qqai-dsh.service" /etc/systemd/system/qqai-dsh.service
systemd-analyze verify /etc/systemd/system/qqai-dsh.service
systemctl daemon-reload
systemctl enable --now qqai-dsh.service
systemctl is-active qqai-dsh.service
