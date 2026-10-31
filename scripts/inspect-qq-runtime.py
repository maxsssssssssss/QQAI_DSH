#!/usr/bin/env python3
"""Read-only, metadata-only inspection of the real Aurabot runtime.

Run on the server with access to this project's systemd journal. Authentication
stays in memory. Output excludes QQ numbers, chat/session contents, credentials,
free-form errors and nicknames. This is readiness evidence, not QQ acceptance.
"""
import http.cookiejar
import json
import math
import re
import subprocess
import urllib.parse
import urllib.request

ORIGIN = 'http://127.0.0.1:3080'


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if f'{parsed.scheme}://{parsed.netloc}' != ORIGIN:
            raise ValueError('nonlocal redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def connect():
    invocation = subprocess.check_output(['systemctl', 'show', 'qqai-dsh.service',
        '--property=InvocationID', '--value'], text=True, stderr=subprocess.DEVNULL).strip()
    if not re.fullmatch(r'[a-f0-9]{32}', invocation):
        raise ValueError('service not running')
    startup = subprocess.check_output(['journalctl', '--no-pager', '-o', 'cat',
        f'_SYSTEMD_INVOCATION_ID={invocation}', '--grep=dsh web:', '-n', '1'], text=True,
        stderr=subprocess.DEVNULL)
    urls = re.findall(r'dsh web: (https?://\S+)', startup)
    if not urls:
        raise ValueError('startup authentication unavailable')
    parsed = urllib.parse.urlsplit(urls[-1])
    if f'{parsed.scheme}://{parsed.netloc}' != ORIGIN:
        raise ValueError('unexpected origin')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), SameOriginRedirect())
    with opener.open(urls[-1], timeout=15) as response:
        response.read(1024)
    return opener


def fetch_json(opener, path):
    with opener.open(ORIGIN + path, timeout=20) as response:
        data = response.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError('oversized response')
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError('unexpected schema')
    return value


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def inspect():
    state = fetch_json(connect(), '/aurabot/api/state')
    config = state.get('config', {})
    onebot = state.get('onebot', {})
    stats = state.get('stats', {})
    speakup = state.get('speakUp', {})
    allowed_states = {'stopped', 'connecting', 'connected', 'disconnected', 'unconfigured', 'error'}
    module_ids = {'memory', 'mood', 'speakup', 'qq-tools', 'qqai-compat', 'purpose'}
    modules = state.get('modules', [])
    if isinstance(modules, dict):
        modules = modules.get('list', [])
    return {
        'scope': 'readiness and counters only; not a claim of QQ acceptance',
        'enabled': config.get('enabled') is True,
        'dryRun': config.get('dryRun') is True,
        'ownerConfigured': bool(config.get('ownerQQ')),
        'botConfigured': bool(config.get('botQQ')),
        'onebotState': onebot.get('state') if onebot.get('state') in allowed_states else 'unknown',
        'botIdentityMatches': bool(config.get('botQQ')) and
            str((onebot.get('login') or {}).get('uin', '')) == str(config['botQQ']),
        'allowPrivateCount': len(config.get('allow', {}).get('private', [])),
        'allowGroupCount': len(config.get('allow', {}).get('groups', [])),
        'stats': {key: number(stats.get(key)) for key in ('received', 'sent', 'voice', 'stickers', 'errors')},
        'speakUpEnabled': config.get('speakUp', {}).get('enabled') is True,
        'speakUp': {key: number(speakup.get(key)) for key in ('count', 'nextAt', 'last', 'nudgedFor')},
        'memoryLastConsolidate': {key: number((state.get('memory', {}).get('lastConsolidate') or {}).get(key))
                                 for key in ('at', 'added', 'pending', 'failed')}
                                if isinstance(state.get('memory', {}).get('lastConsolidate'), dict) else None,
        'modules': [{'id': item['id'], 'enabled': item.get('enabled') is True,
                     'running': item.get('running') if item.get('running') in ('builtin', 'user') else None,
                     'hasError': bool(item.get('error'))}
                    for item in modules if isinstance(item, dict) and item.get('id') in module_ids],
    }


if __name__ == '__main__':
    try:
        print(json.dumps(inspect(), ensure_ascii=False))
    except Exception:
        # Never print a traceback or a response that might carry private fields.
        print(json.dumps({'inspectionError': 'qq_runtime_inspection_failed'}))
        raise SystemExit(1)
