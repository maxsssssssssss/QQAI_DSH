#!/usr/bin/env python3
"""Install the owner-only reminder module, with private snapshot verification.

Run as root. --enable enables both the module and its scheduling switch. Without
--enable only stage disabled code. The installer issues no explicit model/test
message request, service restart, QQ container/volume operation or existing state
rewrite. Enabling the scheduler allows existing due tasks to run normally,
including optional artwork when the compatibility module enables that policy.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
DATA = Path('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot')
MODULE = 'qqai-reminders'
FILES = ('engine.mjs', 'stickers.mjs', 'index.mjs')  # dependencies before entrypoint
LIMIT = 16 * 1024 * 1024


def check(condition):
    if not condition:
        raise ValueError('precondition or verification failed')


def helper_module():
    spec = importlib.util.spec_from_file_location('qqai_reminder_private_ops', ROOT / 'deployment/set-proactive.py')
    check(spec is not None and spec.loader is not None)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_raw(path):
    check(path.resolve() == path and not path.is_symlink())
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        check(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
        data = stream.read(LIMIT + 1)
        end = os.fstat(stream.fileno())
    check(len(data) <= LIMIT and len(data) == info.st_size)
    check((info.st_size, info.st_mtime_ns, info.st_ctime_ns) ==
          (end.st_size, end.st_mtime_ns, end.st_ctime_ns))
    return {'raw': data, 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': stat.S_IMODE(info.st_mode), 'inode': info.st_ino,
            'device': info.st_dev, 'mtime_ns': info.st_mtime_ns,
            'ctime_ns': info.st_ctime_ns}


def unrelated(config):
    value = json.loads(json.dumps(config))
    value.get('modules', {}).pop(MODULE, None)
    value.get('ext', {}).pop(MODULE, None)
    return value


def private_subdir(path):
    check(not path.is_symlink())
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    check(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700)
    return path


def snapshot(helper, record):
    """Stable file snapshot and isolated reconstruction, never a live restore.

    Scope is the top-level Aurabot JSON state (including memory and mapping),
    Heybox/reminder state, and all three module files this installer can replace.
    QQ login volumes, full DSH transcripts, and unrelated code are not modified
    and are outside this incremental snapshot.
    """
    paths = set(DATA.glob('*.json'))
    required = {DATA / name for name in ('config.json', 'memories.json', 'sessions.json', 'speakup.json')}
    check(required <= paths)
    optional = [DATA / 'modules-data' / 'qqai-heybox-reader' / 'reader-state.json',
                DATA / 'modules-data' / MODULE / 'reminders.json']
    optional.extend(DATA / 'modules' / MODULE / name for name in FILES)
    absent = []
    for path in optional:
        check(not path.is_symlink())
        if path.exists():
            paths.add(path)
        else:
            absent.append(str(path.relative_to(DATA)))
    files = {path: read_raw(path) for path in sorted(paths)}
    backup = private_subdir(record / 'before')
    restored = private_subdir(record / 'isolated-restore')
    inventory = []
    for path, item in files.items():
        rel = path.relative_to(DATA)
        for base in (backup, restored):
            target = base / rel
            current = base
            for part in rel.parts[:-1]:
                current = private_subdir(current / part)
            helper.atomic_write(target, item['raw'], uid=0, gid=0, mode=0o600)
            check(read_raw(target)['raw'] == item['raw'])
        if path.suffix == '.json':
            check(isinstance(json.loads(item['raw'].decode('utf-8-sig')), (dict, list)))
        inventory.append({'path': str(rel), 'sha256': hashlib.sha256(item['raw']).hexdigest(),
                          'bytes': len(item['raw']), 'uid': item['uid'], 'gid': item['gid'],
                          'mode': item['mode']})
    # A timer or concurrent operator changing a selected source invalidates the
    # pre-change snapshot; fail before installation instead of overwriting it.
    check(all(read_raw(path) == item for path, item in files.items()))
    manifest = {'scope': 'incremental-aurabot-config-memory-state-and-reminder-code',
                'createdUtc': dt.datetime.now(dt.timezone.utc).isoformat(),
                'sourceRoot': str(DATA), 'files': inventory, 'absent': sorted(absent),
                'isolatedByteRestoreVerified': True, 'liveRestorePerformed': False,
                'gatewayVolumesIncluded': False, 'fullDshTranscriptsIncluded': False}
    helper.save_private(record, 'backup-manifest.private.json', manifest)
    return files, len(files)


def post(opener, inspector, patch):
    req = urllib.request.Request(inspector.ORIGIN + '/aurabot/api/save',
        data=json.dumps(patch, allow_nan=False).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    with opener.open(req, timeout=30) as response:
        raw = response.read(LIMIT + 1)
    check(len(raw) <= LIMIT and json.loads(raw).get('ok') is True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record-dir', required=True)
    parser.add_argument('--enable', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    record = None
    stage = 'preconditions'
    result = {'operation': 'install-owner-reminders', 'ok': False,
              'serviceRestarted': False, 'gatewayRestarted': False,
              'modelOrTestMessageRequested': False, 'existingStateWritten': False,
              'nativeScheduleEdited': False, 'saveRequestAttempted': False}
    try:
        check(os.geteuid() == 0)
        helper = helper_module()
        parent = Path(args.record_dir)
        check(parent.is_absolute() and parent.resolve() == parent)
        private_subdir(parent)
        record = Path(tempfile.mkdtemp(prefix='reminders-', dir=parent))
        helper.save_private(record, 'result.json', result)
        before = helper.read_file(DATA / 'config.json')
        cfg = before['value']
        check(cfg.get('ext', {}).get(MODULE, {}).get('enabled', False) is False)
        check(cfg.get('modules', {}).get(MODULE, {}).get('enabled', False) is False)
        if args.enable:
            check(cfg.get('enabled') is True and cfg.get('dryRun') is False)
        inspector = helper.inspector()
        opener = inspector.connect()
        live_before = inspector.fetch_json(opener, '/aurabot/api/state')['config']
        sources = {name: read_raw(ROOT / 'adapters' / MODULE / name)['raw'] for name in FILES}
        stage = 'private-snapshot-and-isolated-verification'
        snapshots, count = snapshot(helper, record)
        check(snapshots[DATA / 'config.json']['raw'] == before['raw'])
        result.update(backupFileCount=count, isolatedRestoreVerified=True)
        helper.save_private(record, 'result.json', result)
        stage = 'stage-disabled-module'
        destination = DATA / 'modules' / MODULE
        check(destination.resolve() == destination and not destination.is_symlink())
        destination.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chown(destination, before['uid'], before['gid'])
        os.chmod(destination, 0o700)
        check(helper.unchanged_file(helper.read_file(DATA / 'config.json'), before))
        for name in FILES:
            target = destination / name
            check(not target.is_symlink())
            helper.atomic_write(target, sources[name], uid=before['uid'], gid=before['gid'], mode=0o600)
        stage = 'save-module-only-configuration'
        # Loading staged defaults may add only this module's disabled settings.
        check(unrelated(helper.read_file(DATA / 'config.json')['value']) == unrelated(cfg))
        result['saveRequestAttempted'] = True
        helper.save_private(record, 'result.json', result)
        post(opener, inspector, {'modules': {MODULE: {'enabled': args.enable}},
                                'ext': {MODULE: {'enabled': args.enable}}})
        stage = 'verify-runtime-and-preservation'
        deadline = time.monotonic() + 30
        while True:
            live = inspector.fetch_json(opener, '/aurabot/api/state')
            modules = live.get('modules', [])
            if isinstance(modules, dict):
                modules = modules.get('list', [])
            loaded = next((item for item in modules if item.get('id') == MODULE), {})
            if loaded.get('error'):
                check(False)
            if args.enable:
                done = loaded.get('running') == 'user' and loaded.get('enabled') is True
            else:
                done = loaded.get('running') is None and loaded.get('enabled') is False
            if done:
                break
            check(time.monotonic() < deadline)
            time.sleep(1)
        if args.enable:
            status = inspector.fetch_json(opener, '/aurabot/api/ext/' + MODULE + '/state')
            check(status.get('ok') is True and status.get('enabled') is True)
            check(status.get('ready') is True and status.get('storageFailed') is False)
        after = helper.read_file(DATA / 'config.json')
        check(unrelated(after['value']) == unrelated(cfg))
        check(unrelated(live['config']) == unrelated(live_before))
        check(all(after[key] == before[key] for key in ('uid', 'gid', 'mode')))
        check(after['value']['modules'][MODULE]['enabled'] is args.enable)
        check(after['value']['ext'][MODULE]['enabled'] is args.enable)
        for name in FILES:
            deployed = read_raw(destination / name)
            check(deployed['raw'] == sources[name])
            check(deployed['uid'] == before['uid'] and deployed['gid'] == before['gid'] and deployed['mode'] == 0o600)
        result.update(ok=True, enabled=args.enable, moduleLoaded=args.enable,
                      otherConfigUnchanged=True, credentialsUnchanged=True,
                      moduleSha256={name: hashlib.sha256(raw).hexdigest() for name, raw in sources.items()})
    except Exception:
        result.update(stage=stage, reviewRequired=True,
                      error='installation-or-verification-failed-private-details-omitted')
    if record:
        helper.save_private(record, 'result.json', result)
        result['recordDir'] = str(record)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
