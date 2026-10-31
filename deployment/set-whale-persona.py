#!/usr/bin/env python3
"""Apply the owner's Xiaojing persona through the existing QQ adapter, hot.

Only ext.qqai-compat.personaText / botName and the adapter entry are changed.
Backups contain private runtime files; rollback restores only code and those
two settings, never old memories, conversation mappings or schedule counters.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path('/opt/qqai-dsh/source')
DATA = Path('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot')
MODULE = 'qqai-compat'
OLD_SHA = '1cd51e4d8bbd18278309620aa647cea82cb7631618fed372dc49e6ddae1c3d55'


def check(value):
    if not value:
        raise ValueError('precondition-or-verification-failed')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unrelated(cfg):
    result = json.loads(json.dumps(cfg))
    ext = result['ext'][MODULE]
    ext.pop('botName', None)
    ext.pop('personaText', None)
    return result


def invocation():
    return subprocess.check_output(['systemctl', 'show', 'qqai-dsh.service',
        '--property=InvocationID', '--value'], text=True).strip()


def gateway():
    data = json.loads(subprocess.check_output(['docker', 'inspect', 'qqai-dsh-snowluma']))[0]
    check(data['State']['Running'])
    return data['State']['StartedAt']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record-dir', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    record = None
    config_changed = code_changed = False
    result = {'ok': False, 'operation': 'replace-whale-persona-xiaojing',
        'serviceRestartRequested': False, 'gatewayRestartRequested': False,
        'manualQqSendRequested': False, 'memoryOrHistoryWriteRequested': False}
    try:
        check(os.geteuid() == 0)
        spec = importlib.util.spec_from_file_location('ops', SOURCE / 'deployment/set-proactive.py')
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        parent = Path(args.record_dir)
        check(parent.is_absolute() and parent.resolve() == parent)
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        check(parent.stat().st_uid == 0 and stat.S_IMODE(parent.stat().st_mode) == 0o700)
        record = Path(tempfile.mkdtemp(prefix='persona-', dir=parent))
        q = helper.inspector()
        opener = q.connect()

        def post(path, payload):
            req = urllib.request.Request(q.ORIGIN + path, data=json.dumps(payload).encode(),
                headers={'Content-Type': 'application/json'}, method='POST')
            with opener.open(req, timeout=30) as response:
                value = json.load(response)
            check(value.get('ok') is True)
            return value

        config = helper.read_file(DATA / 'config.json')
        old_settings = config['value']['ext'][MODULE]
        check(old_settings.get('ownerName') == '主人')
        live_before = q.fetch_json(opener, '/aurabot/api/state')
        check(live_before.get('onebot', {}).get('state') == 'connected')
        target = DATA / 'modules' / MODULE / 'index.mjs'
        check(not target.is_symlink())
        old_code, metadata = target.read_bytes(), target.stat()
        check(sha(old_code) == OLD_SHA)
        source = ROOT / 'adapters' / MODULE / 'index.mjs'
        new_code = source.read_bytes()
        persona = (ROOT / 'personas/xiaojing.md').read_text().strip()
        check('你的名字是小鲸，称呼对方为主人' in persona and len(persona) < 20000)
        subprocess.run(['/opt/qqai-dsh/node-v24.22.2-linux-x64/bin/node', '--check', str(source)],
                       check=True, capture_output=True)
        process_before, gateway_before = invocation(), gateway()
        check(bool(process_before))
        paths = {'adapter.before.mjs': target, 'config.before.json': DATA / 'config.json',
                 'memories.before.json': DATA / 'memories.json',
                 'sessions.before.json': DATA / 'sessions.json',
                 'speakup.before.json': DATA / 'speakup.json',
                 'reader.before.json': DATA / 'modules-data/qqai-heybox-reader/reader-state.json',
                 'reminders.before.json': DATA / 'modules-data/qqai-reminders/state.json'}
        paths = {key: value for key, value in paths.items() if value.exists()}
        raw_before = {key: value.read_bytes() for key, value in paths.items()}
        restored = record / 'restore-check'
        restored.mkdir(mode=0o700)
        for name, raw in raw_before.items():
            helper.save_private(record, name, raw, raw=True)
            helper.save_private(restored, name, (record / name).read_bytes(), raw=True)
            check((restored / name).read_bytes() == raw)
            if name.endswith('.json'):
                json.loads((restored / name).read_bytes())
        helper.save_private(record, 'backup-manifest.json', {
            key: {'sha256': sha(raw), 'bytes': len(raw)} for key, raw in raw_before.items()})
        check(helper.unchanged_file(helper.read_file(DATA / 'config.json'), config))
        # Save first: the old module ignores the new text until the atomic code update.
        config_changed = True
        post('/aurabot/api/save', {'ext': {MODULE: {'botName': '小鲸', 'personaText': persona}}})
        helper.atomic_write(target, new_code, uid=metadata.st_uid, gid=metadata.st_gid,
                            mode=stat.S_IMODE(metadata.st_mode))
        code_changed = True
        post('/aurabot/api/modules/reload', {'id': MODULE})
        effective = q.fetch_json(opener, '/aurabot/api/ext/' + MODULE + '/persona-state')
        check(effective.get('personaSha256') == sha(persona.encode()) and effective.get('customPersona') is True)
        live_after = q.fetch_json(opener, '/aurabot/api/state')
        disk_after = helper.read_file(DATA / 'config.json')['value']
        for old, new in [(config['value'], disk_after), (live_before['config'], live_after['config'])]:
            check(unrelated(old) == unrelated(new))
            check(new['ext'][MODULE]['botName'] == '小鲸' and new['ext'][MODULE]['personaText'] == persona)
        modules = live_after.get('modules', [])
        if isinstance(modules, dict):
            modules = modules.get('list', [])
        loaded = next((m for m in modules if m.get('id') == MODULE), {})
        check(loaded.get('enabled') is True and loaded.get('running') == 'user' and not loaded.get('error'))
        check(target.read_bytes() == new_code)
        check(invocation() == process_before and gateway() == gateway_before)
        check(live_after.get('onebot', {}).get('state') == 'connected')
        check(str((live_after['onebot'].get('login') or {}).get('uin')) == str(disk_after['botQQ']))
        result.update(ok=True, at=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(),
            botName='小鲸', ownerName='主人', personaSha256=sha(persona.encode()),
            moduleSha256=sha(new_code), effectivePersonaMatchesFile=True, moduleLoaded=True,
            unrelatedConfigUnchanged=True, serviceInvocationUnchanged=True, gatewayStartUnchanged=True,
            qqConnected=True, botIdentityMatches=True, backupRestoreVerified=True, backupFiles=len(paths),
            privateStateBytePreserved={key: path.read_bytes() == raw_before[key] for key, path in paths.items()
                                      if key not in ('adapter.before.mjs', 'config.before.json')})
    except Exception:
        result['error'] = 'persona-update-or-verification-failed-private-details-omitted'
        if config_changed or code_changed:
            try:
                if code_changed:
                    check(target.read_bytes() == new_code)
                    helper.atomic_write(target, old_code, uid=metadata.st_uid, gid=metadata.st_gid,
                                        mode=stat.S_IMODE(metadata.st_mode))
                if config_changed:
                    post('/aurabot/api/save', {'ext': {MODULE: {
                        'botName': old_settings.get('botName', '大肥鱼'),
                        'personaText': old_settings.get('personaText', '')}}})
                post('/aurabot/api/modules/reload', {'id': MODULE})
                result['targetedRollbackVerified'] = True
            except Exception:
                result['targetedRollbackVerified'] = False
    if record:
        result['recordDir'] = str(record)
        helper.save_private(record, 'result.json', result)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
