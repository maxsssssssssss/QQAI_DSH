#!/usr/bin/env python3
"""Load a systemd credential into the DSH process without command-line secrets."""
import os
from pathlib import Path

credential_dir = os.environ.get('CREDENTIALS_DIRECTORY')
if not credential_dir:
    raise SystemExit('Start via qqai-dsh.service; systemd credential directory missing')
key = (Path(credential_dir) / 'deepseek-api-key').read_text(encoding='utf-8-sig').strip()
if not key.startswith('sk-') or any(c.isspace() for c in key):
    raise SystemExit('DeepSeek credential format is invalid')
env = os.environ.copy()
env['DEEPSEEK_API_KEY'] = key
env['DSH_HOME'] = '/srv/qqai-dsh/home/.dsh'
env['TZ'] = 'Asia/Shanghai'
env['DSH_TELEMETRY_DISABLED'] = '1'
env['PATH'] = '/opt/qqai-dsh/node-v24.22.2-linux-x64/bin:/opt/qqai-dsh/app/node_modules/.bin:/usr/bin:/bin'
node = '/opt/qqai-dsh/node-v24.22.2-linux-x64/bin/node'
os.execve(node, [node, '/opt/qqai-dsh/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
                '--profile', 'web',
                '--no-open', '--host', '127.0.0.1', '--port', '3080'], env)

