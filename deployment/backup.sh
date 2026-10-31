#!/usr/bin/env bash
set -euo pipefail
umask 077
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/backup_restore.py" backup "$@"
