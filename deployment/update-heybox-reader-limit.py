#!/usr/bin/env python3
"""Hot-update only the pinned Heybox reader from three to five articles.

Back up the module and relevant private state, verify isolated backup copies,
then rely on Aurabot's native file watcher. Never edit configuration, reader
state, memory, or proactive scheduling; never restart services or send messages.
On failure restore only the module code, not any evolving runtime state.
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

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path('/opt/qqai-dsh/source')
DATA = Path('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot')
MODULE = 'qqai-heybox-reader'
OLD_SHA = '9bc32440d5bb437b025fd53d32acb0dd2d538a83b7cedd636c02a4f3a1d5a1da'
NODE = '/opt/qqai-dsh/node-v24.22.2-linux-x64/bin/node'


def require(ok):
    if not ok:
        raise ValueError('precondition-or-verification-failed')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def service_identity():
    return subprocess.check_output(['systemctl', 'show', 'qqai-dsh.service',
        '--property=InvocationID', '--value'], text=True).strip()


def gateway_identity():
    value = json.loads(subprocess.check_output(['docker', 'inspect', 'qqai-dsh-snowluma']))[0]
    require(value['State']['Running'])
    return value['State']['StartedAt']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record-dir', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    record = None
    changed = False
    result = {'ok': False, 'operation': 'heybox-reader-five-articles',
              'serviceRestartRequested': False, 'gatewayRestartRequested': False,
              'configOrStateWriteRequested': False, 'manualModelOrQqSendRequested': False}
    try:
        require(os.geteuid() == 0)
        spec = importlib.util.spec_from_file_location('ops', SOURCE / 'deployment/set-proactive.py')
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        parent = Path(args.record_dir)
        require(parent.is_absolute() and parent.resolve() == parent)
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        require(parent.stat().st_uid == 0 and stat.S_IMODE(parent.stat().st_mode) == 0o700)
        record = Path(tempfile.mkdtemp(prefix='limit-', dir=parent))
        target = DATA / 'modules' / MODULE / 'index.mjs'
        require(not target.is_symlink())
        before = target.read_bytes()
        metadata = target.stat()
        require(digest(before) == OLD_SHA)
        source = ROOT / 'adapters' / MODULE / 'index.mjs'
        replacement = source.read_bytes()
        # Accept exactly this quantity change and its observable module metadata.
        expected = before.replace(b'const INTERVAL = 4 * 60 * 60_000\n',
            b'const INTERVAL = 4 * 60 * 60_000\nconst ARTICLES_PER_ROUND = 5\n')
        require(expected.count(b'.slice(0, 3)') == 3)
        expected = expected.replace(b'.slice(0, 3)', b'.slice(0, ARTICLES_PER_ROUND)')
        expected = expected.replace(b'enabled: getSettings()?.enabled === true, blocked:',
            b'enabled: getSettings()?.enabled === true, articlesPerRound: ARTICLES_PER_ROUND, blocked:')
        expected = expected.replace(b"version: '0.1.0'", b"version: '0.1.1'")
        require(replacement == expected)
        subprocess.run([NODE, '--check', str(source)], check=True, capture_output=True)
        q = helper.inspector()
        opener = q.connect()
        live_before = q.fetch_json(opener, '/aurabot/api/state')
        reader_before = q.fetch_json(opener, '/aurabot/api/ext/' + MODULE + '/state')
        require(reader_before.get('enabled') is True and not reader_before.get('inFlight'))
        require(not reader_before.get('blocked') and not reader_before.get('lastError'))
        require(live_before.get('onebot', {}).get('state') == 'connected')
        invocation, gateway = service_identity(), gateway_identity()
        require(bool(invocation))
        paths = {'index.before.mjs': target, 'config.before.json': DATA / 'config.json',
            'reader.before.json': DATA / 'modules-data' / MODULE / 'reader-state.json',
            'speakup.before.json': DATA / 'speakup.json',
            'memories.before.json': DATA / 'memories.json', 'sessions.before.json': DATA / 'sessions.json'}
        originals = {name: path.read_bytes() for name, path in paths.items()}
        restored = record / 'restore-check'
        restored.mkdir(mode=0o700)
        manifest = {}
        for name, raw in originals.items():
            helper.save_private(record, name, raw, raw=True)
            helper.save_private(restored, name, (record / name).read_bytes(), raw=True)
            require((restored / name).read_bytes() == raw)
            if name.endswith('.json'):
                json.loads((restored / name).read_bytes())
            manifest[name] = {'sha256': digest(raw), 'bytes': len(raw)}
        helper.save_private(record, 'backup-manifest.json', manifest)
        require(all(path.read_bytes() == originals[name] for name, path in paths.items()))
        helper.atomic_write(target, replacement, uid=metadata.st_uid, gid=metadata.st_gid,
                            mode=stat.S_IMODE(metadata.st_mode))
        changed = True
        deadline = time.monotonic() + 25
        while True:
            try:
                reader_after = q.fetch_json(opener, '/aurabot/api/ext/' + MODULE + '/state')
                if reader_after.get('articlesPerRound') == 5:
                    break
            except Exception:
                pass
            require(time.monotonic() < deadline)
            time.sleep(1)
        live_after = q.fetch_json(opener, '/aurabot/api/state')
        modules = live_after.get('modules', [])
        if isinstance(modules, dict):
            modules = modules.get('list', [])
        loaded = next((item for item in modules if item.get('id') == MODULE), {})
        require(loaded.get('running') == 'user' and loaded.get('enabled') is True and not loaded.get('error'))
        require(reader_after.get('enabled') is True and not reader_after.get('blocked'))
        require(target.read_bytes() == replacement)
        require(live_before['config'] == live_after['config'])
        require(service_identity() == invocation and gateway_identity() == gateway)
        require(live_after.get('onebot', {}).get('state') == 'connected')
        require(str((live_after['onebot'].get('login') or {}).get('uin')) == str(live_after['config'].get('botQQ')))
        preserved = {name: path.read_bytes() == originals[name] for name, path in paths.items()
                     if name != 'index.before.mjs'}
        require(preserved['config.before.json'])
        # Runtime timers remain live. Record concurrent changes, never overwrite them.
        result.update(ok=True, at=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(),
            articlesPerRound=5, moduleSha256=digest(replacement), moduleLoaded=True,
            hotReloadVerified=True, backupFiles=len(originals), backupRestoreVerified=True,
            bytePreserved=preserved, liveConfigUnchanged=True, serviceInvocationUnchanged=True,
            gatewayStartUnchanged=True, qqConnected=True, botIdentityMatches=True,
            readerScheduleUnchanged=all(reader_before.get(k) == reader_after.get(k)
                for k in ('nextBrowseAt', 'lastBrowseAt', 'roundsToday')),
            nextBrowseAt=reader_after.get('nextBrowseAt'), queuedArticles=reader_after.get('queued'))
    except Exception:
        result['error'] = 'update-or-verification-failed-private-details-omitted'
        if changed:
            try:
                require(target.read_bytes() == replacement)
                helper.atomic_write(target, before, uid=metadata.st_uid, gid=metadata.st_gid,
                                    mode=stat.S_IMODE(metadata.st_mode))
                result['moduleCodeRolledBack'] = True
            except Exception:
                result['moduleCodeRolledBack'] = False
    if record:
        result['recordDir'] = str(record)
        helper.save_private(record, 'result.json', result)
    print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
