#!/usr/bin/env python3
"""Apply 30 native proactive attempts/day and 40-80 minute scheduling, with one DSH-only restart.

Run from a staged copy of this repository as root. Snapshot private state and
the exact replaced files; rollback code/config automatically if startup fails.
Never restore old memory/state over a running conversation or restart QQ.
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
import traceback
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path('/opt/qqai-dsh/source')
DATA = Path('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot')
PROFILE = DATA.parents[1] / 'profiles/web'
NODE = '/opt/qqai-dsh/node-v24.22.2-linux-x64/bin/node'
PATCH_FILES = ('scripts/patch-plugin-media.mjs', 'scripts/qq-delivery-patch-spec.mjs',
               'scripts/memory-limits-patch-spec.mjs', 'scripts/proactive-limits-patch-spec.mjs')
TARGETS = {'speakUp': {'maxPerDay': 30, 'minIntervalMinutes': 40, 'maxIntervalMinutes': 80}}


def check(value):
    if not value:
        raise ValueError('maintenance verification failed')


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def run(args, timeout=45):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=timeout, cwd=SOURCE).stdout


def unrelated(config):
    copy = json.loads(json.dumps(config))
    for section, fields in TARGETS.items():
        for key in fields:
            copy.get(section, {}).pop(key, None)
    return copy


def read_package_source(path):
    """pnpm may hard-link untouched public source; copy it, never edit in place.

    This exception is used only for the pinned package code destination. Private
    config/state still use read_raw's single-link requirement. Atomic replacement
    later detaches this installation from the shared package-store inode.
    """
    check(path.resolve() == path and not path.is_symlink())
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        check(stat.S_ISREG(info.st_mode) and info.st_nlink >= 1)
        raw = stream.read(16 * 1024 * 1024 + 1)
        end = os.fstat(stream.fileno())
    check(len(raw) <= 16 * 1024 * 1024 and len(raw) == info.st_size)
    check((info.st_size, info.st_mtime_ns, info.st_ctime_ns) ==
          (end.st_size, end.st_mtime_ns, end.st_ctime_ns))
    return {'raw': raw, 'uid': info.st_uid, 'gid': info.st_gid,
            'mode': stat.S_IMODE(info.st_mode)}


def wait_online(inspector, seconds=50):
    end = time.monotonic() + seconds
    while True:
        try:
            state = inspector.fetch_json(inspector.connect(), '/aurabot/api/state')
            login = state.get('onebot', {}).get('login') or {}
            if (state.get('onebot', {}).get('state') == 'connected'
                    and str(login.get('uin')) == str(state['config']['botQQ'])):
                return state
        except Exception:
            pass
        check(time.monotonic() < end)
        time.sleep(1)


def check_idle(inspector, opener):
    mappings = json.loads((DATA / 'sessions.json').read_text())['chats']
    def rpc(method, args):
        request = urllib.request.Request(inspector.ORIGIN + '/api/' + method,
            data=json.dumps({'type': 'client-request', 'rpcId': str(uuid.uuid4()),
                            'method': method, 'payload': {'args': args}}).encode(),
            headers={'content-type': 'application/json'})
        with opener.open(request, timeout=20) as response:
            result = json.load(response)['result']
        check(result['ok'])
        return result['value']
    for value in mappings.values():
        sid = value['sessionId']
        projection = rpc('session/projections', {'request': {'sessionId': sid}})
        page = rpc('session/page', {'request': {'address': {'kind': 'session', 'sessionId': sid},
                    'throughSeq': projection['asOfSeq'], 'maxMessages': 100}})
        events = [row.get('event', {}) for row in page.get('records', [])]
        start = max((e.get('seq', 0) for e in events if e.get('type') == 'turn/start'), default=0)
        end = max((e.get('seq', 0) for e in events if e.get('type') == 'turn/end'), default=0)
        # A full page without turn boundaries cannot prove a long turn is idle.
        check(not (len(events) >= 100 and start == 0 and end == 0))
        check(start <= end)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record-dir', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    check(os.geteuid() == 0)
    helper = module('private_ops', ROOT / 'deployment/set-proactive.py')
    files = module('private_files', ROOT / 'deployment/install-reminders.py')
    inspector = module('runtime_inspector', ROOT / 'scripts/inspect-qq-runtime.py')
    parent = Path(args.record_dir)
    check(parent.is_absolute() and parent.resolve() == parent)
    files.private_subdir(parent)
    record = Path(tempfile.mkdtemp(prefix='proactive-', dir=parent))
    result = {'ok': False, 'operation': 'native-proactive-30-per-day-40-80-minutes',
              'gatewayRestarted': False, 'testMessageRequested': False,
              'memoryWritten': False, 'recordDir': str(record)}
    originals, installed, stopped, started = {}, [], False, False
    stage = 'preflight'
    try:
        state = wait_online(inspector)
        disk_before = files.read_raw(DATA / 'config.json')['raw']
        check_idle(inspector, inspector.connect())
        check(state['config']['speakUp']['idleMinutes'] == 40)
        check(state['config']['speakUp']['enabled'] is True)
        check(state['config']['model']['reasoningEffort'] == 'off')
        check(state['config']['model']['model'] == 'deepseek-flash')
        gateway = json.loads(run(['docker', 'inspect', 'qqai-dsh-snowluma']))[0]['State']['StartedAt']
        invocation = run(['systemctl', 'show', 'qqai-dsh.service', '--property=InvocationID', '--value']).strip()
        packages = [(PROFILE / 'node_modules' / name).resolve()
                    for name in ('dsh-aurabot-qq', 'dsh-nekowhale-stickers')]
        run([NODE, str(SOURCE / PATCH_FILES[0]), '--check', *map(str, packages)])
        new_sources = {SOURCE / rel: files.read_raw(ROOT / rel)['raw'] for rel in PATCH_FILES}
        code = [packages[0] / 'src/core/config.js']
        config_path = DATA / 'config.json'
        state_path = DATA / 'speakup.json'
        stage = 'stop-dsh-and-backup'
        run(['systemctl', 'stop', 'qqai-dsh.service'])
        stopped = True
        selected = set(DATA.glob('*.json')) | set((DATA / 'chatlog').glob('*.jsonl'))
        selected |= set(code) | {config_path, PROFILE / 'cordis.patch.yml'}
        for rel in ('modules-data/qqai-heybox-reader/reader-state.json',
                    'modules-data/qqai-reminders/reminders.json'):
            if (DATA / rel).exists():
                selected.add(DATA / rel)
        selected |= set(new_sources)
        before = files.private_subdir(record / 'before')
        restored = files.private_subdir(record / 'isolated-restore')
        inventory = []
        for index, path in enumerate(sorted(selected)):
            item = (read_package_source(path) if path in code else files.read_raw(path)) if path.exists() else None
            originals[path] = item
            name = str(index) + '.private'
            if item:
                for directory in (before, restored):
                    helper.atomic_write(directory / name, item['raw'], uid=0, gid=0, mode=0o600)
                    check(files.read_raw(directory / name)['raw'] == item['raw'])
                if path.suffix == '.json':
                    json.loads(item['raw'])
                elif path.suffix == '.jsonl':
                    for line in item['raw'].splitlines():
                        if line.strip():
                            json.loads(line)
            inventory.append({'target': str(path), 'backup': name, 'present': item is not None,
                **({k: item[k] for k in ('uid', 'gid', 'mode')} if item else {}),
                **({'sha256': hashlib.sha256(item['raw']).hexdigest()} if item else {})})
        helper.save_private(record, 'manifest.private.json', {
            'scope': 'Aurabot configuration/state/chatlog, profile, changed code and startup patch definitions',
            'files': inventory, 'isolatedRestoreVerified': True,
            'fullDshTranscriptsIncluded': False, 'qqLoginVolumesIncluded': False})
        cfg = json.loads(originals[config_path]['raw'])
        # The web API masks credentials and adds *Set flags. Compare each
        # representation with its own pre-change snapshot, never across them.
        check(originals[config_path]['raw'] == disk_before)
        stage = 'apply-reviewed-files-and-config'
        for path, raw in new_sources.items():
            installed.append(path)
            helper.atomic_write(path, raw, uid=0, gid=0, mode=0o644)
        # All pinned package sources are validated before any file is replaced.
        installed.extend(code)
        run([NODE, str(SOURCE / PATCH_FILES[0]), *map(str, packages)])
        # Node's atomic replacement inherits the private maintenance umask and
        # root owner. Restore the reviewed package file permissions explicitly.
        for path in code:
            item = originals[path]
            os.chown(path, item['uid'], item['gid'])
            os.chmod(path, item['mode'])
        run(['runuser', '-u', 'dsh', '--', NODE, str(SOURCE / PATCH_FILES[0]),
             '--check', *map(str, packages)])
        updated = json.loads(json.dumps(cfg))
        for section, fields in TARGETS.items():
            updated.setdefault(section, {}).update(fields)
        item = originals[config_path]
        installed.append(config_path)
        helper.atomic_write(config_path, (json.dumps(updated, ensure_ascii=False, indent=2) + '\n').encode(),
                            uid=item['uid'], gid=item['gid'], mode=item['mode'])
        check(unrelated(json.loads(config_path.read_text())) == unrelated(cfg))
        # The scheduler is stopped. Invalidate only the old deadline; preserve
        # day/count/last/nudgedFor and let its own minute tick choose 40-80 minutes.
        previous_schedule = json.loads(originals[state_path]['raw'])
        new_schedule = {**previous_schedule, 'nextAt': 0}
        item = originals[state_path]
        helper.atomic_write(state_path, (json.dumps(new_schedule, ensure_ascii=False, indent=2) + '\n').encode(),
                            uid=item['uid'], gid=item['gid'], mode=item['mode'])
        check(json.loads(state_path.read_text()) == new_schedule)
        reset_at = time.time() * 1000
        result['onlyScheduleFieldWritten'] = 'nextAt=0'
        # Every unrelated selected file is byte-identical before restart.
        unchanged = [p for p in originals if p not in installed and p != state_path and originals[p]]
        check(all(files.read_raw(p)['raw'] == originals[p]['raw'] for p in unchanged))
        stage = 'start-and-check-runtime'
        run(['systemctl', 'start', 'qqai-dsh.service'])
        stopped, started = False, True
        live = wait_online(inspector)
        check(unrelated(live['config']) == unrelated(state['config']))
        check(unrelated(json.loads(config_path.read_text())) == unrelated(cfg))
        check(all(live['config'][s][k] == v for s, fields in TARGETS.items() for k, v in fields.items()))
        check(gateway == json.loads(run(['docker', 'inspect', 'qqai-dsh-snowluma']))[0]['State']['StartedAt'])
        check(invocation != run(['systemctl', 'show', 'qqai-dsh.service', '--property=InvocationID', '--value']).strip())
        run([NODE, str(SOURCE / PATCH_FILES[0]), '--check', *map(str, packages)])
        post_checks = {str(p.relative_to(DATA)): files.read_raw(p)['raw'] == originals[p]['raw']
                       for p in unchanged if p.is_relative_to(DATA)}
        check(all(post_checks.values()))
        modules = live.get('modules', [])
        if isinstance(modules, dict):
            modules = modules.get('list', [])
        check(not any(m.get('error') for m in modules if m.get('enabled')))
        # No forced tick or model call: observe the existing native minute timer.
        end = time.monotonic() + 80
        while True:
            scheduled = json.loads(state_path.read_text())
            deadline = scheduled.get('nextAt', 0)
            if isinstance(deadline, (int, float)) and deadline > 0:
                break
            check(time.monotonic() < end)
            time.sleep(1)
        check(reset_at + 40 * 60_000 <= deadline <= time.time() * 1000 + 80 * 60_000)
        skip = {'day', 'count', 'nextAt'}
        check({k: v for k, v in scheduled.items() if k not in skip} ==
              {k: v for k, v in previous_schedule.items() if k not in skip})
        rolled_over = scheduled.get('day') != previous_schedule.get('day')
        if rolled_over:
            from zoneinfo import ZoneInfo
            check(scheduled['day'] == dt.datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%a %b %d %Y'))
            check(scheduled['count'] == 0)
        else:
            check(scheduled.get('count') == previous_schedule.get('count'))
        final = wait_online(inspector)
        check(unrelated(final['config']) == unrelated(state['config']))
        result['nativeSchedule'] = {'oldDay': previous_schedule.get('day'),
            'oldCount': previous_schedule.get('count'), 'day': scheduled.get('day'),
            'count': scheduled.get('count'), 'nativeDayRollover': rolled_over,
            'countResetByInstaller': False, 'nextAt': deadline, 'intervalRangeVerifiedMinutes': [40, 80],
            'nativeTimerObserved': True, 'atBeijing': dt.datetime.fromtimestamp(deadline / 1000,
                dt.timezone(dt.timedelta(hours=8))).isoformat()}
        result.update(ok=True, at=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(),
            targets=TARGETS, isolatedRestoreVerified=True, backupFiles=sum(x is not None for x in originals.values()),
            dshRestarted=True, qqReconnected=True, botIdentityMatches=True,
            gatewayProcessUnchanged=True, unrelatedConfigurationUnchanged=True,
            byteIdenticalState=post_checks,
            sourceSha256={str(p.relative_to(packages[0])): hashlib.sha256(p.read_bytes()).hexdigest() for p in code})
    except Exception as error:
        result.update(stage=stage, error='maintenance-failed-private-details-omitted')
        result['errorType'] = type(error).__name__
        result['errorFrames'] = [{'file': Path(frame.filename).name, 'line': frame.lineno}
                                 for frame in traceback.extract_tb(error.__traceback__)]
        if installed:
            try:
                run(['systemctl', 'stop', 'qqai-dsh.service'])
                stopped = True
                for path in reversed(installed):
                    item = originals[path]
                    if path == config_path:
                        current = json.loads(config_path.read_text())
                        previous = json.loads(item['raw'])
                        for section, fields in TARGETS.items():
                            for key in fields:
                                current[section][key] = previous[section][key]
                        helper.atomic_write(path, (json.dumps(current, ensure_ascii=False, indent=2) + '\n').encode(),
                                            uid=item['uid'], gid=item['gid'], mode=item['mode'])
                        continue
                    if item is None:
                        if path.exists():
                            path.unlink()  # only a new patch-source file from this transaction
                    else:
                        helper.atomic_write(path, item['raw'], uid=item['uid'], gid=item['gid'], mode=item['mode'])
                result['codeAndConfigRolledBack'] = True
                if result.get('onlyScheduleFieldWritten'):
                    item = files.read_raw(state_path)
                    restored_schedule = json.loads(item['raw'])
                    restored_schedule['nextAt'] = 0
                    helper.atomic_write(state_path,
                        (json.dumps(restored_schedule, ensure_ascii=False, indent=2) + '\n').encode(),
                        uid=item['uid'], gid=item['gid'], mode=item['mode'])
                    result['rollbackRescheduleRequestedWithoutCounterReset'] = True
            except Exception:
                result['rollbackNeedsReview'] = True
        if stopped:
            try:
                run(['systemctl', 'start', 'qqai-dsh.service'])
                wait_online(inspector)
                result['previousServiceRestored'] = True
            except Exception:
                result['serviceNeedsReview'] = True
    helper.save_private(record, 'result.json', result)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
