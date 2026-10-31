#!/usr/bin/env python3
"""Print only non-secret service/port/authentication status; no model requests."""
import json
import subprocess
import urllib.error
import urllib.request
import uuid

raw = subprocess.check_output(['systemctl', 'show', 'qqai-dsh.service',
    '--property=ActiveState,SubState,MainPID,NRestarts,User,Group,MemoryCurrent,MemoryPeak'], text=True)
service = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
listeners = []
for row in subprocess.check_output(['ss', '-H', '-ltn'], text=True).splitlines():
    columns = row.split()
    if len(columns) < 4:
        continue
    endpoint = columns[3]
    try:
        port = int(endpoint.rsplit(':', 1)[1])
    except ValueError:
        continue
    if port in (3080, 5099, 6081, 3000, 3001):
        listeners.append(endpoint)
body = json.dumps({'type': 'client-request', 'rpcId': str(uuid.uuid4()), 'method': 'session/list',
                   'payload': {'args': {'request': {}}}}).encode()
request = urllib.request.Request('http://127.0.0.1:3080/api/session/list', data=body,
    headers={'Content-Type': 'application/json'}, method='POST')
try:
    with urllib.request.urlopen(request, timeout=8) as response:
        status = response.status
except urllib.error.HTTPError as error:
    status = error.code
except (OSError, urllib.error.URLError):
    status = 'unreachable'
safe = all(endpoint.startswith(('127.0.0.1:', '[::1]:')) for endpoint in listeners)
healthy = service.get('ActiveState') == 'active' and status == 401 and safe
print(json.dumps({'service': service, 'listeners': listeners, 'all_application_ports_loopback': safe,
    'unauthenticated_rpc_http_status': status, 'healthy': healthy,
    'scope': 'process and authentication readiness only; not model or QQ acceptance'}))
raise SystemExit(0 if healthy else 1)
