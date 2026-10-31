#!/usr/bin/env python3
"""Install the project read-only Heybox module without restarting DSH.

Default: stage disabled. --cookie-file imports a local private credential file;
--enable additionally permits the scheduled reader. Enable only after a real
read-only account/feed/detail probe. This script never probes or sends messages.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
DATA = Path('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot')
MODULE = 'qqai-heybox-reader'
API_FILE = Path('/srv/qqai-dsh/home/.dsh/profiles/web/node_modules/dsh-aurabot-qq/src/heybox/api.js')
API_SHA = '033737291d37f08edecd14ca83c049b434916deb51a64c3a60caee36e66b1faa'


def check(ok):
    if not ok:
        raise ValueError('precondition or verification failed')


def load_helper():
    spec = importlib.util.spec_from_file_location('qqai_private_file_ops', ROOT / 'deployment/set-proactive.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def unrelated(config, *, public=False):
    value = json.loads(json.dumps(config))
    value.get('modules', {}).pop(MODULE, None)
    value.get('ext', {}).pop(MODULE, None)
    value.get('heybox', {}).pop('cookie', None)
    if public:
        value.get('heybox', {}).pop('cookieSet', None)
    return value


def credential(filename):
    path = Path(filename)
    check(path.is_absolute() and path.resolve() == path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        check(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0)
        check(stat.S_IMODE(info.st_mode) == 0o600)
        raw = stream.read(65537)
    check(len(raw) <= 65536)
    value = raw.decode('utf-8-sig').strip()
    value = re.sub(r'^Cookie:\s*', '', value, count=1, flags=re.I)
    check(bool(re.search(r'(?:^|;\s*)pkey=[^;\s]+', value)))
    check(all(32 <= ord(char) < 127 for char in value))
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record-dir', required=True)
    parser.add_argument('--cookie-file')
    parser.add_argument('--enable', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    record = None
    result = {'operation': 'install-readonly-heybox-reader', 'ok': False,
              'serviceRestarted': False, 'manualModelOrQqSendRequested': False,
              'nativeScheduleEdited': False}
    try:
        check(os.geteuid() == 0)
        helper = load_helper()
        parent = Path(args.record_dir)
        check(parent.is_absolute() and parent.resolve() == parent)
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = parent.stat()
        check(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700)
        record = Path(tempfile.mkdtemp(prefix='heybox-', dir=parent))
        source = (ROOT / 'adapters' / MODULE / 'index.mjs').read_bytes()
        check(hashlib.sha256(API_FILE.read_bytes()).hexdigest() == API_SHA)
        before = helper.read_file(DATA / 'config.json')
        cfg = before['value']
        check(cfg.get('ext', {}).get(MODULE, {}).get('enabled', False) is False)
        check(cfg.get('modules', {}).get('heybox', {}).get('enabled') is False)
        check(cfg.get('heybox', {}).get('enabled') is False and cfg['heybox'].get('autoBrowse') is False)
        check(all(cfg.get('profilePerms', {}).get(key) == 'off'
                  for key in ['heyboxBrowse', 'heyboxLike', 'heyboxComment', 'heyboxPost']))
        helper.save_private(record, 'config.before.json', before['raw'], raw=True)
        inspector = helper.inspector()
        opener = inspector.connect()
        live_before = inspector.fetch_json(opener, '/aurabot/api/state')['config']
        patch = {'modules': {MODULE: {'enabled': True}}, 'ext': {MODULE: {'enabled': args.enable}}}
        if args.cookie_file:
            patch['heybox'] = {'cookie': credential(args.cookie_file)}
        check(not args.enable or bool(patch.get('heybox', {}).get('cookie') or cfg['heybox'].get('cookie')))
        destination = DATA / 'modules' / MODULE
        check(not destination.is_symlink())
        destination.mkdir(mode=0o700, exist_ok=True)
        os.chown(destination, before['uid'], before['gid'])
        os.chmod(destination, 0o700)
        target = destination / 'index.mjs'
        check(not target.is_symlink())
        if target.exists():
            helper.save_private(record, 'index.before.mjs', target.read_bytes(), raw=True)
        check(helper.unchanged_file(helper.read_file(DATA / 'config.json'), before))
        helper.atomic_write(target, source, uid=before['uid'], gid=before['gid'], mode=0o600)
        request = urllib.request.Request(inspector.ORIGIN + '/aurabot/api/save',
            data=json.dumps(patch).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        with opener.open(request, timeout=30) as response:
            saved = json.loads(response.read(8 * 1024 * 1024))
        check(saved.get('ok') is True)
        after = helper.read_file(DATA / 'config.json')
        deadline = time.monotonic() + 20
        while True:
            live_state = inspector.fetch_json(opener, '/aurabot/api/state')
            modules = live_state.get('modules', [])
            if isinstance(modules, dict):
                modules = modules.get('list', [])
            loaded = next((item for item in modules if item.get('id') == MODULE), {})
            if loaded.get('error') or (loaded.get('running') == 'user' and loaded.get('enabled') is True):
                break
            check(time.monotonic() < deadline)
            time.sleep(1)
        check(loaded.get('running') == 'user' and loaded.get('enabled') is True and not loaded.get('error'))
        reader_state = inspector.fetch_json(opener, '/aurabot/api/ext/' + MODULE + '/state')
        check(reader_state.get('enabled') is args.enable)
        live_after = live_state['config']
        check(unrelated(cfg) == unrelated(after['value']))
        check(unrelated(live_before, public=True) == unrelated(live_after, public=True))
        if args.cookie_file:
            check(after['value']['heybox']['cookie'] == patch['heybox']['cookie'])
        else:
            check(after['value']['heybox'].get('cookie') == cfg['heybox'].get('cookie'))
        check(all(before[key] == after[key] for key in ['uid', 'gid', 'mode']))
        check(after['value']['ext'][MODULE]['enabled'] is args.enable)
        check(after['value']['modules'][MODULE]['enabled'] is True)
        check(target.read_bytes() == source)
        result.update(ok=True, enabled=args.enable, otherConfigUnchanged=True, moduleLoaded=True,
                      credentialImported=bool(args.cookie_file), moduleSha256=hashlib.sha256(source).hexdigest())
    except Exception:
        result.update(reviewRequired=True, error='installation-or-verification-failed-private-details-omitted')
    if record:
        helper.save_private(record, 'result.json', result)
        result['recordDir'] = str(record)
    print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
