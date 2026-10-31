#!/usr/bin/env python3
"""Enable the owner's agreed native proactive schedule without restarting DSH.

Run as root with --record-dir pointing to a root-owned 0700 maintenance folder.
Private backups and the transaction result go into a unique child directory.
This changes configuration only: no manual fire, artificial clock, chat record,
model request, service restart, or reset of the current day's attempt counter.
The existing native timer is allowed to schedule and run after enablement.
"""
import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import urllib.request
from zoneinfo import ZoneInfo


DATA_DIR = Path('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot')
CONFIG_FILE = DATA_DIR / 'config.json'
STATE_FILE = DATA_DIR / 'speakup.json'
TARGET = {
    'enabled': True,
    'maxPerDay': 20,
    'minIntervalMinutes': 30,
    'maxIntervalMinutes': 60,
    'idleMinutes': 40,
    'awakeFrom': 8,
    'awakeTo': 23,
    'nudge': False,
}
LIMIT = 8 * 1024 * 1024


def require(condition):
    if not condition:
        raise ValueError('precondition or verification failed')


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()


def read_file(path, *, optional=False):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        if optional:
            return None
        raise
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
        raw = stream.read(LIMIT + 1)
    require(len(raw) <= LIMIT)
    value = json.loads(raw.decode('utf-8-sig'))
    require(isinstance(value, dict))
    return {'raw': raw, 'value': value, 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': stat.S_IMODE(info.st_mode), 'inode': info.st_ino,
            'device': info.st_dev}


def atomic_write(path, raw, *, uid, gid, mode):
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), uid, gid)
            os.fchmod(stream.fileno(), mode)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def save_private(directory, name, value, *, raw=False):
    atomic_write(directory / name, value if raw else encoded(value),
                 uid=0, gid=0, mode=0o600)


def private_record_dir(value):
    path = Path(value)
    require(path.is_absolute() and path.resolve() == path and not path.is_symlink())
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
            stat.S_IMODE(info.st_mode) == 0o700)
    return Path(tempfile.mkdtemp(prefix='proactive-', dir=path))


def inspector():
    path = Path(__file__).resolve().parents[1] / 'scripts' / 'inspect-qq-runtime.py'
    spec = importlib.util.spec_from_file_location('qqai_runtime_inspector', path)
    require(spec is not None and spec.loader is not None)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    require(module.ORIGIN == 'http://127.0.0.1:3080')
    return module


def purpose_off(config):
    module = config.get('modules', {}).get('purpose', {})
    extra = config.get('ext', {}).get('purpose', {})
    return module.get('enabled') is False and extra.get('enabled', False) is False


def modules_ready(state):
    modules = state.get('modules')
    if isinstance(modules, dict):
        modules = modules.get('list')
    require(isinstance(modules, list))
    selected = {item.get('id'): item for item in modules if isinstance(item, dict)}
    purpose = selected.get('purpose', {})
    native = selected.get('speakup', {})
    require(purpose.get('enabled') is False and purpose.get('running') is None)
    require(native.get('enabled') is True and native.get('running') == 'builtin'
            and not native.get('error'))


def without_schedule(config):
    return {key: value for key, value in config.items() if key != 'speakUp'}


def unchanged_file(current, original):
    return current is not None and all(current[key] == original[key]
        for key in ('raw', 'uid', 'gid', 'mode', 'inode', 'device'))


def verify_state_transition(before, after):
    """Accept native initialization/rollover, never disguise a counter reset."""
    if before is None:
        return {'stateExistedBefore': False, 'scriptCreatedState': False,
                'counterResetByScript': False,
                'nativeStateObservedAfter': after is not None}
    require(after is not None)
    require(all(after[key] == before[key] for key in ('uid', 'gid', 'mode')))
    old, new = before['value'], after['value']
    require({k: v for k, v in old.items() if k not in ('nextAt', 'day', 'count')} ==
            {k: v for k, v in new.items() if k not in ('nextAt', 'day', 'count')})
    if old.get('day') == new.get('day'):
        require(('day' in old) == ('day' in new) and
                ('count' in old) == ('count' in new) and
                old.get('count') == new.get('count'))
        rollover = False
    else:
        # tick can normalize an older persisted day once enabled. It is not a
        # script counter reset. The pre-enable snapshot proves our only edit.
        today = dt.datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%a %b %d %Y')
        require(new.get('day') == today and new.get('count') == 0)
        rollover = True
    return {'stateExistedBefore': True, 'scriptCreatedState': False,
            'counterResetByScript': False, 'otherStateFieldsPreserved': True,
            'ownerAndModePreserved': True, 'nativeDayRolloverObserved': rollover,
            'nativeStateObservedAfter': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record-dir', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    record = None
    stage = 'root-and-record-directory'
    result = {'operation': 'enable-native-proactive', 'target': TARGET,
              'startedUtc': dt.datetime.now(dt.timezone.utc).isoformat(),
              'stateWriteAttempted': False, 'saveRequestAttempted': False,
              'rollbackAttempted': False, 'modelOrManualFireRequested': False,
              'serviceRestartRequested': False}
    try:
        require(os.geteuid() == 0)
        record = private_record_dir(args.record_dir)
        save_private(record, 'result.json', result)
        stage = 'read-live-and-disk-preconditions'
        helper = inspector()
        opener = helper.connect()
        live_before = helper.fetch_json(opener, '/aurabot/api/state')
        public_before = live_before.get('config')
        require(isinstance(public_before, dict))
        config_before = read_file(CONFIG_FILE)
        disk_before = config_before['value']
        for config in (public_before, disk_before):
            require(config.get('enabled') is True and config.get('dryRun') is False)
            require(config.get('speakUp', {}).get('enabled') is False and purpose_off(config))
        require(public_before.get('speakUp') == disk_before.get('speakUp'))
        require(public_before.get('ownerQQ') == disk_before.get('ownerQQ') and
                bool(disk_before.get('ownerQQ')))
        modules_ready(live_before)
        state_before = read_file(STATE_FILE, optional=True)
        save_private(record, 'config.before.json', config_before['raw'], raw=True)
        save_private(record, 'live-config.before.json', public_before)
        save_private(record, 'state.before.json',
                     {'exists': state_before is not None,
                      'value': state_before['value'] if state_before else None})
        if state_before:
            save_private(record, 'state.before.original.json', state_before['raw'], raw=True)
            save_private(record, 'state.before.file-metadata.json',
                         {key: state_before[key] for key in ('uid', 'gid', 'mode')})

        stage = 'invalidate-only-the-old-next-deadline'
        # The native timer returns before loading/writing state while disabled.
        # Refuse concurrent config/state changes instead of overwriting them.
        check = helper.fetch_json(opener, '/aurabot/api/state')
        require(check.get('config') == public_before)
        modules_ready(check)
        require(unchanged_file(read_file(CONFIG_FILE), config_before))
        current_state = read_file(STATE_FILE, optional=True)
        if state_before:
            require(unchanged_file(current_state, state_before))
            updated = dict(state_before['value'])
            updated['nextAt'] = 0
            result['stateWriteAttempted'] = True
            save_private(record, 'result.json', result)
            atomic_write(STATE_FILE, encoded(updated), uid=state_before['uid'],
                         gid=state_before['gid'], mode=state_before['mode'])
            reset = read_file(STATE_FILE)
            require(reset['value'] == updated and all(reset[key] == state_before[key]
                        for key in ('uid', 'gid', 'mode')))
        else:
            require(current_state is None)
            reset = None
        save_private(record, 'state.after-deadline-reset.json',
                     {'exists': reset is not None, 'value': reset['value'] if reset else None,
                      'onlyRequestedStateEdit': 'nextAt=0' if reset else 'none'})

        stage = 'save-only-the-approved-speakup-fields'
        request = urllib.request.Request(helper.ORIGIN + '/aurabot/api/save',
            data=encoded({'speakUp': TARGET}),
            headers={'Content-Type': 'application/json'}, method='POST')
        result['saveRequestAttempted'] = True
        save_private(record, 'result.json', result)
        requested_at = time.time() * 1000
        with opener.open(request, timeout=30) as response:
            body = response.read(LIMIT + 1)
        require(len(body) <= LIMIT)
        save_response = json.loads(body)
        # The response can contain credentials indicators, IDs and private
        # state. Keep it in memory; never print it or its exception text.
        require(isinstance(save_response, dict) and save_response.get('ok') is True)

        stage = 'verify-persisted-and-live-config-and-state'
        config_after = read_file(CONFIG_FILE)
        live_after = helper.fetch_json(opener, '/aurabot/api/state')
        public_after = live_after.get('config')
        require(isinstance(public_after, dict))
        save_private(record, 'config.after.json', config_after['raw'], raw=True)
        save_private(record, 'live-config.after.json', public_after)
        expected_disk = {**disk_before.get('speakUp', {}), **TARGET}
        expected_public = {**public_before.get('speakUp', {}), **TARGET}
        require(config_after['value'].get('speakUp') == expected_disk)
        require(public_after.get('speakUp') == expected_public)
        require(without_schedule(config_after['value']) == without_schedule(disk_before))
        require(without_schedule(public_after) == without_schedule(public_before))
        require(purpose_off(public_after) and purpose_off(config_after['value']))
        require(all(config_after[key] == config_before[key] for key in ('uid', 'gid', 'mode')))
        modules_ready(live_after)
        state_after = read_file(STATE_FILE, optional=True)
        save_private(record, 'state.after.json',
                     {'exists': state_after is not None,
                      'value': state_after['value'] if state_after else None})
        preservation = verify_state_transition(state_before, state_after)
        deadline = state_after['value'].get('nextAt', 0) if state_after else 0
        require(type(deadline) in (int, float) and deadline >= 0)
        if deadline:
            require(requested_at + 30 * 60_000 <= deadline <= time.time() * 1000 + 60 * 60_000)
        result.update({'ok': True, 'stage': 'verified', 'reviewRequired': False,
            'otherDiskConfigUnchanged': True, 'otherLiveConfigUnchanged': True,
            'configOwnerAndModePreserved': True, 'purposeDisabled': True,
            'statePreservation': preservation,
            'nativeDeadlineObserved': bool(deadline),
            'nativeDeadlineMs': deadline or None,
            'acceptance': 'configuration verified; native model decision and QQ receipt not yet verified',
            'completedUtc': dt.datetime.now(dt.timezone.utc).isoformat()})
        save_private(record, 'result.json', result)
        print(json.dumps({'ok': True, 'recordDir': str(record),
                          'nativeDeadlineObserved': bool(deadline),
                          'nextStep': 'observe the native timer without manual fire'}))
        return 0
    except Exception:
        # A timed-out save may already have applied. Do not retry, reset the
        # counter, or claim rollback: preserve evidence for operator inspection.
        result.update({'ok': False, 'stage': stage,
            'reviewRequired': result['stateWriteAttempted'] or result['saveRequestAttempted'],
            'error': 'proactive_configuration_not_verified',
            'completedUtc': dt.datetime.now(dt.timezone.utc).isoformat()})
        if record:
            try:
                save_private(record, 'result.json', result)
            except Exception:
                pass
        print(json.dumps({'ok': False, 'error': result['error'], 'stage': stage,
                          'reviewRequired': result['reviewRequired'],
                          'recordDir': str(record) if record else None,
                          'rollbackAttempted': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
