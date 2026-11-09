#!/usr/bin/env python3
"""Apply the owner's Xiaojing persona through the existing QQ adapter, hot.

With --text-only, only ext.qqai-compat.personaText changes and the existing
adapter is reloaded. Its installed code must match the reviewed source.
Without that flag, the original pinned migration also changes botName/code.
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
    parser.add_argument('--text-only', action='store_true')
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
        idle_spec = importlib.util.spec_from_file_location('idle', SOURCE / 'deployment/update-native-proactive.py')
        idle = importlib.util.module_from_spec(idle_spec)
        idle_spec.loader.exec_module(idle)
        idle.check_idle(q, opener)
        target = DATA / 'modules' / MODULE / 'index.mjs'
        check(not target.is_symlink())
        old_code, metadata = target.read_bytes(), target.stat()
        source = ROOT / 'adapters' / MODULE / 'index.mjs'
        new_code = source.read_bytes()
        check(old_code == new_code if args.text_only else sha(old_code) == OLD_SHA)
        if args.text_only:
            check(old_settings.get('botName') == '小鲸')
        active = json.loads((ROOT / 'versions.lock.json').read_bytes())['runtime_state']['active_persona']
        source_file = (ROOT / active['source']).resolve()
        check(source_file.parent == (ROOT / 'personas').resolve() and source_file.suffix == '.md')
        raw_persona = source_file.read_bytes()
        persona = raw_persona.decode('utf-8').strip()
        check(0 < len(persona) <= 20000 and sha(raw_persona) == active['source_file_sha256']
              and sha(persona.encode()) == active['effective_text_sha256'])
        subprocess.run(['/opt/qqai-dsh/node-v24.22.2-linux-x64/bin/node', '--check', str(source)],
                       check=True, capture_output=True)
        process_before, gateway_before = invocation(), gateway()
        check(bool(process_before))
        paths = {'adapter.before.mjs': target, 'config.before.json': DATA / 'config.json',
                 'memories.before.json': DATA / 'memories.json',
                 'sessions.before.json': DATA / 'sessions.json',
                 'speakup.before.json': DATA / 'speakup.json',
                 'reader.before.json': DATA / 'modules-data/qqai-heybox-reader/reader-state.json',
                 'reminders.before.json': DATA / 'modules-data/qqai-reminders/reminders.json'}
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
        # The current adapter captures persona during setup, so reload after save.
        config_changed = True
        patch = {'personaText': persona}
        if not args.text_only:
            patch['botName'] = '小鲸'
        post('/aurabot/api/save', {'ext': {MODULE: patch}})
        if not args.text_only:
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
            textOnly=args.text_only, adapterCodeWritten=code_changed,
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
                    rollback = {'personaText': old_settings.get('personaText', '')}
                    if not args.text_only:
                        rollback['botName'] = old_settings.get('botName', '大肥鱼')
                    post('/aurabot/api/save', {'ext': {MODULE: rollback}})
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
