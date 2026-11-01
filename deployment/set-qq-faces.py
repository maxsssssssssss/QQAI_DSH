#!/usr/bin/env python3
"""Hot-update only native QQ stickers.faces, with private backups and verification."""
import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DATA = Path('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot')


def check(value):
    if not value:
        raise ValueError('QQ faces configuration verification failed')


def unrelated(config):
    value = json.loads(json.dumps(config))
    value.get('stickers', {}).pop('faces', None)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record-dir', required=True)
    choices = parser.add_mutually_exclusive_group(required=True)
    choices.add_argument('--enable', action='store_true')
    choices.add_argument('--disable', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    record = None
    result = {'operation': 'set-native-qq-faces', 'ok': False,
              'serviceRestarted': False, 'qqMessageRequested': False,
              'modelTestRequested': False, 'memoryOrScheduleWritten': False}
    try:
        check(os.geteuid() == 0)
        spec = importlib.util.spec_from_file_location('qqai_private_ops', ROOT / 'deployment/set-proactive.py')
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        parent = Path(args.record_dir)
        check(parent.is_absolute() and parent.resolve() == parent)
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        check(parent.stat().st_uid == 0 and stat.S_IMODE(parent.stat().st_mode) == 0o700)
        record = Path(tempfile.mkdtemp(prefix='faces-', dir=parent))
        before = helper.read_file(DATA / 'config.json')
        cfg = before['value']
        helper.save_private(record, 'config.before.json', before['raw'], raw=True)
        helper.save_private(record, 'config.isolated-restore.json', before['raw'], raw=True)
        check((record / 'config.before.json').read_bytes() == (record / 'config.isolated-restore.json').read_bytes() == before['raw'])
        inspector = helper.inspector()
        opener = inspector.connect()
        live_before = inspector.fetch_json(opener, '/aurabot/api/state')
        invocation = subprocess.check_output(['systemctl', 'show', 'qqai-dsh.service', '--property=InvocationID', '--value'], text=True).strip()
        check(helper.unchanged_file(helper.read_file(DATA / 'config.json'), before))
        request = urllib.request.Request(inspector.ORIGIN + '/aurabot/api/save',
            data=json.dumps({'stickers': {'faces': args.enable}}).encode(),
            headers={'Content-Type': 'application/json'}, method='POST')
        with opener.open(request, timeout=30) as response:
            check(json.loads(response.read(8 * 1024 * 1024)).get('ok') is True)
        after = helper.read_file(DATA / 'config.json')
        live_after = inspector.fetch_json(opener, '/aurabot/api/state')
        check(after['value']['stickers']['faces'] is args.enable)
        check(live_after['config']['stickers']['faces'] is args.enable)
        check(unrelated(cfg) == unrelated(after['value']))
        check(unrelated(live_before['config']) == unrelated(live_after['config']))
        check(all(before[k] == after[k] for k in ('uid', 'gid', 'mode')))
        modules = live_after.get('modules', [])
        if isinstance(modules, dict):
            modules = modules.get('list', [])
        module = next((v for v in modules if v.get('id') == 'qqai-compat'), {})
        check(module.get('enabled') is True and module.get('running') == 'user' and not module.get('error'))
        same_process = invocation == subprocess.check_output(['systemctl', 'show', 'qqai-dsh.service', '--property=InvocationID', '--value'], text=True).strip()
        check(same_process)
        result.update(ok=True, recordedAt=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(),
                      beforeFaces=cfg['stickers'].get('faces'), afterFaces=args.enable,
                      otherConfigurationUnchanged=True, isolatedBackupVerified=True,
                      serviceProcessUnchanged=same_process, moduleLoaded=True,
                      currentModel={k:live_after['config']['model'].get(k) for k in ('provider','model','reasoningEffort')},
                      onebotState=live_after.get('onebot', {}).get('state'))
    except Exception:
        result.update(error='qq-faces-update-or-verification-failed-private-details-omitted')
    if record:
        helper.save_private(record, 'result.json', result)
        result['recordDir'] = str(record)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
