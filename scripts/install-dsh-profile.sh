#!/usr/bin/env bash
# Run as the dedicated DSH user, with its service stopped. No key is needed.
set -euo pipefail
umask 077
if [[ $# != 3 ]]; then
  printf 'Usage: DSH_BIN=/absolute/path/to/dsh %s DSH_HOME WORKSPACE PORT\n' "$0" >&2
  exit 2
fi
task_dsh_home=$1
task_workspace=$2
task_port=$3
case "$task_dsh_home:$task_workspace" in /*:/*) ;; *) printf 'Both directories must be absolute.\n' >&2; exit 2;; esac
task_repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
task_locks_dir="$task_repo/deployment/locks"
task_profile="$task_dsh_home/profiles/web"
task_pnpm_store=${DSH_PNPM_STORE_DIR:-"$task_dsh_home/toolchain/pnpm-store"}
task_dsh_bin=${DSH_BIN:-$(command -v dsh)}
task_node_bin=$(command -v node)
task_npm_bin=$(command -v npm)
[[ $("$task_dsh_bin" --version) == '0.2.1-rc.5' ]] || { printf 'Expected DSH 0.2.1-rc.5.\n' >&2; exit 1; }
mkdir -p -- "$task_dsh_home" "$task_workspace" "$task_dsh_home/toolchain"
chmod 700 -- "$task_dsh_home"
cd -- "$task_workspace"
export DSH_HOME="$task_dsh_home"
unset DEEPSEEK_API_KEY
"$task_npm_bin" install --prefix "$task_dsh_home/toolchain" --ignore-scripts --no-audit --no-fund --save-exact pnpm@11.28.5
export PATH="$task_dsh_home/toolchain/node_modules/.bin:$PATH"
[[ $(pnpm --version) == '11.28.5' ]] || { printf 'Unexpected pnpm version.\n' >&2; exit 1; }
if [[ -f "$task_locks_dir/profile-package.json" && -f "$task_locks_dir/pnpm-lock.yaml" ]]; then
  # This read-only CLI operation initializes a new profile's official workspace
  # settings without fetching packages or granting compatibility exemptions.
  "$task_dsh_bin" plugin --profile web version-exemptions > /dev/null
  install -m 600 -- "$task_locks_dir/profile-package.json" "$task_profile/package.json"
  install -m 600 -- "$task_locks_dir/pnpm-lock.yaml" "$task_profile/pnpm-lock.yaml"
  "$task_dsh_bin" plugin --profile web install --frozen-lockfile --ignore-scripts --store-dir="$task_pnpm_store"
  cmp -- "$task_locks_dir/pnpm-lock.yaml" "$task_profile/pnpm-lock.yaml"
elif [[ -e "$task_locks_dir/profile-package.json" || -e "$task_locks_dir/pnpm-lock.yaml" ]]; then
  printf 'Profile lock pair is incomplete; refusing unlocked installation.\n' >&2
  exit 1
else
  printf 'No captured profile lock found; resolving fixed plugin versions for the first capture.\n'
  "$task_dsh_bin" plugin --profile web add --save-exact --ignore-scripts --store-dir="$task_pnpm_store" \
    'github:accomplish07zrh-eng/dsh-aurabot-qq#e9026a99d9db58974363c416eaa9e555499737fa' \
    'github:Kaalia0912/dsh-whale-musume-persona#0fbdcf217e3bf94e35fef36f7ac56134b704529b' \
    'dsh-nekowhale-stickers@1.1.1'
fi
"$task_node_bin" "$task_repo/scripts/patch-plugin-media.mjs" \
  "$task_dsh_home/profiles/web/node_modules/dsh-aurabot-qq" \
  "$task_dsh_home/profiles/web/node_modules/dsh-nekowhale-stickers"
"$task_node_bin" "$task_repo/scripts/configure-dsh-profile.mjs" "$task_dsh_home" "$task_workspace" "$task_port"
mkdir -p -- "$task_dsh_home/audit"
"$task_dsh_bin" --profile web --dump-config > "$task_dsh_home/audit/composed-profile.yml"
printf 'Profile prepared; QQ sending is disabled. Start the existing web profile without repeating the safe overlay.\n'
