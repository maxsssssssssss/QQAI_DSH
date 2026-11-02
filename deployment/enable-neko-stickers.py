#!/usr/bin/env python3
"""Enable reviewed owner-only Neko usage with a DSH-only restart and verified backup.

Run from a staged public checkout. Never restart SnowLuma or restore old evolving
chat/memory/reminder state. Rollback replaces only code and this change's settings.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import traceback

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path('/opt/qqai-dsh/source')
HOME_DIR = Path('/srv/qqai-dsh/home/.dsh')
DATA = HOME_DIR / 'plugins-data/aurabot'
PROFILE = HOME_DIR / 'profiles/web'
NODE = '/opt/qqai-dsh/node-v24.22.2-linux-x64/bin/node'
MODULES = ('qqai-compat', 'qqai-reminders', 'qqai-heybox-reader')
OLD_ENTRY_HASHES = {
    'qqai-compat': '18aaf28196b7aa2726a78f675ce8094f57db2555613959281d920a6da8039c6d',
    'qqai-reminders': 'b943245ab7d2e59a7fa4505f475b4f00b0fa516f6a55e112cf6558f7a53543f6',
    'qqai-heybox-reader': '063a707e0fcacbfa82938d8c2ec4f4248c388cdf3b71262f69c1cd19fa562aeb',
}
PATCH_FILES = ('scripts/patch-plugin-media.mjs', 'scripts/qq-delivery-patch-spec.mjs',
    'scripts/memory-limits-patch-spec.mjs', 'scripts/proactive-limits-patch-spec.mjs',
    'scripts/neko-network-patch-spec.mjs', 'scripts/sticker-turn-patch-spec.mjs')


def check(ok):
    if not ok:
        raise ValueError('sticker-maintenance-verification-failed')


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def run(args, timeout=60):
    return subprocess.run(args, check=True, capture_output=True, timeout=timeout).stdout


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def unrelated(cfg):
    value = json.loads(json.dumps(cfg))
    value['ext']['qqai-compat'].pop('stickerUsage', None)
    return value


def profile_update(raw, restore_from=None):
    # Preserve the complete profile, including literal off values and secrets.
    import yaml
    text = raw.decode()
    start = text.index('- id: nekowhale-stickers\n  config:\n')
    end = text.find('\n- ', start + 1)
    end = len(text) if end < 0 else end
    block = text[start:end]
    changes = {'packs': ['大肥鱼'], 'whitelist': ['pack:大肥鱼']}
    if restore_from is not None:
        old_entries = yaml.load(restore_from.decode(), Loader=yaml.BaseLoader)
        def find(v):
            if isinstance(v, dict):
                if v.get('id') == 'nekowhale-stickers': return v['config']
                for x in v.values():
                    found = find(x)
                    if found is not None: return found
            elif isinstance(v, list):
                for x in v:
                    found = find(x)
                    if found is not None: return found
            return None
        old_config = find(old_entries); check(old_config is not None)
        changes = {key: old_config.get(key) for key in changes}
    for key, values in changes.items():
        pattern = r'^    ' + key + r':[^\n]*$'
        check(len(re.findall(pattern, block, re.M)) <= 1)
        if values is None:
            block = re.sub(pattern + r'\n?', '', block, flags=re.M)
            continue
        check(isinstance(values, list) and all(isinstance(x, str) for x in values))
        value = json.dumps(values, ensure_ascii=False)
        if re.search(pattern, block, re.M):
            block = re.sub(pattern, '    ' + key + ': ' + value, block, flags=re.M)
        else:
            block = block.replace('  config:\n', '  config:\n    ' + key + ': ' + value + '\n', 1)
    output = text[:start] + block + text[end:]
    old, new = [yaml.load(s, Loader=yaml.BaseLoader) for s in (text, output)]
    def omit(v):
        if isinstance(v, dict):
            if v.get('id') == 'nekowhale-stickers':
                c = v['config']; check(c.get('promptMode') == 'off' and c.get('templates') == 'true')
                c.pop('packs', None); c.pop('whitelist', None)
            for x in v.values(): omit(x)
        elif isinstance(v, list):
            for x in v: omit(x)
    omit(old); omit(new); check(old == new)
    return output.encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record-dir', required=True)
    parser.add_argument('--from-normal', action='store_true',
        help='Upgrade the deployed normal GIF policy and final delivery to the often policy')
    args = parser.parse_args()
    os.umask(0o077)
    check(os.geteuid() == 0)
    helper = module('private_ops', ROOT / 'deployment/set-proactive.py')
    files = module('private_files', ROOT / 'deployment/install-reminders.py')
    previous = module('previous_maintenance', ROOT / 'deployment/update-native-proactive.py')
    q = module('runtime', ROOT / 'scripts/inspect-qq-runtime.py')
    parent = files.private_subdir(Path(args.record_dir))
    record = Path(tempfile.mkdtemp(prefix='enable-', dir=parent))
    result = {'ok': False, 'recordDir': str(record), 'operation': 'single-pack-neko-often-two-per-turn',
        'gatewayRestartRequested': False, 'manualStateResetRequested': False, 'modelOrQqTestRequested': False}
    originals, installed, stopped = {}, [], False
    stage = 'preflight'
    config_path, profile_path = DATA / 'config.json', PROFILE / 'cordis.patch.yml'
    try:
        before = previous.wait_online(q)
        previous.check_idle(q, q.connect())
        reminder = q.fetch_json(q.connect(), '/aurabot/api/ext/qqai-reminders/state')
        check(not reminder.get('inFlight'))
        cfg = json.loads(files.read_raw(config_path)['raw'])
        check(cfg['model']['model'] == 'deepseek-flash' and cfg['model']['reasoningEffort'] == 'off')
        check(cfg['stickers']['faces'] is False and cfg['stickers']['enabled'] is False)
        if args.from_normal:
            check(cfg['ext']['qqai-compat']['stickerUsage'] == 'normal')
            for filename, expected in {
                'index.mjs': '6f63a59e9321efa5b967b6874e22e5ba9feaf3ef4da641155a0bbe65d5bb8415',
                'sticker-policy.mjs': '3b4c3c7bdbfbbd76f4b7bc40634f27f79ec014bbc411b958903f1be9891bc133',
            }.items():
                check(sha((DATA / 'modules/qqai-compat' / filename).read_bytes()) == expected)
        else:
            for name, expected in OLD_ENTRY_HASHES.items():
                check(sha((DATA / 'modules' / name / 'index.mjs').read_bytes()) == expected)
        invocation = run(['systemctl', 'show', 'qqai-dsh.service', '--property=InvocationID', '--value']).strip()
        gateway = json.loads(run(['docker', 'inspect', 'qqai-dsh-snowluma']))[0]['State']['StartedAt']
        packages = [(PROFILE / 'node_modules' / n).resolve() for n in ('dsh-aurabot-qq', 'dsh-nekowhale-stickers')]
        if args.from_normal:
            for patch in json.loads((ROOT / 'versions.lock.json').read_text())['compatibility_patches']:
                path = PROFILE / 'node_modules' / patch['package'] / patch['file']
                expected = ('43aa7dc54ad209673bccc09509277f06fa57ed14653bed3c5cf7d275aea5cddb'
                            if patch['file'] == 'src/chat/hub.js' else patch['after'])
                check(sha(path.read_bytes()) == expected)
        else:
            run([NODE, str(SOURCE / PATCH_FILES[0]), '--check', *map(str, packages)])
        sources = {SOURCE / name: (ROOT / name).read_bytes() for name in PATCH_FILES}
        for name in (('qqai-compat',) if args.from_normal else MODULES):
            for path in (ROOT / 'adapters' / name).glob('*.mjs'):
                run([NODE, '--check', str(path)])
                sources[DATA / 'modules' / name / path.name] = path.read_bytes()
        code = [packages[0] / 'src/chat/hub.js']
        if not args.from_normal:
            code.append(packages[1] / 'lib/core/sync.js')
        stage = 'stop-dsh-and-backup'
        run(['systemctl', 'stop', 'qqai-dsh.service']); stopped = True
        selected = set(DATA.glob('*.json')) | set((DATA / 'chatlog').glob('*.jsonl'))
        selected |= set(sources) | set(code) | {config_path, profile_path}
        for part in ('modules-data/qqai-reminders/reminders.json', 'modules-data/qqai-heybox-reader/reader-state.json'):
            if (DATA / part).exists(): selected.add(DATA / part)
        for path in (HOME_DIR / 'nekowhale-stickers').glob('*.json'):
            selected.add(path)
        # New module state files, if any, are backed up without exposing their contents.
        for name in MODULES:
            selected |= {p for p in (DATA / 'modules-data' / name).rglob('*.json') if p.is_file()}
        backup = files.private_subdir(record / 'before')
        restore = files.private_subdir(record / 'isolated-restore')
        inventory = []
        for i, path in enumerate(sorted(selected)):
            item = (previous.read_package_source(path) if path in code else files.read_raw(path)) if path.exists() else None
            originals[path] = item
            if item:
                for directory in (backup, restore):
                    helper.atomic_write(directory / f'{i}.private', item['raw'], uid=0, gid=0, mode=0o600)
                    check((directory / f'{i}.private').read_bytes() == item['raw'])
                if path.suffix == '.json': json.loads(item['raw'])
                elif path.suffix == '.jsonl':
                    for line in item['raw'].splitlines():
                        if line.strip(): json.loads(line)
            inventory.append({'target': str(path), 'backup': f'{i}.private', 'present': bool(item),
                **({k: item[k] for k in ('uid', 'gid', 'mode')} if item else {}),
                **({'sha256': sha(item['raw'])} if item else {})})
        helper.save_private(record, 'manifest.private.json', {'files': inventory,
            'isolatedRestoreVerified': True, 'qqLoginVolumesIncluded': False,
            'scope': 'changed-code-profile-config-memory-chatlogs-reminders-schedule-sticker-state'})
        check(json.loads(originals[config_path]['raw']) == cfg)
        stage = 'apply'
        for path, raw in sources.items():
            old = originals[path]
            if old and old['raw'] == raw:
                continue
            if path.is_relative_to(DATA):
                parent_info = path.parent.stat()
                uid, gid, mode = (old['uid'], old['gid'], old['mode']) if old else (parent_info.st_uid, parent_info.st_gid, 0o600)
            else: uid, gid, mode = 0, 0, 0o644
            installed.append(path)
            helper.atomic_write(path, raw, uid=uid, gid=gid, mode=mode)
        installed.extend(code)
        run([NODE, str(SOURCE / PATCH_FILES[0]), *map(str, packages)])
        for path in code:
            old = originals[path]; os.chown(path, old['uid'], old['gid']); os.chmod(path, old['mode'])
        updated = json.loads(json.dumps(cfg)); updated['ext']['qqai-compat']['stickerUsage'] = 'often'
        settings = {config_path: (json.dumps(updated, ensure_ascii=False, indent=2)+'\n').encode()}
        if not args.from_normal:
            settings[profile_path] = profile_update(originals[profile_path]['raw'])
        for path, raw in settings.items():
            old = originals[path]; installed.append(path)
            helper.atomic_write(path, raw, uid=old['uid'], gid=old['gid'], mode=old['mode'])
        check(unrelated(json.loads(config_path.read_bytes())) == unrelated(cfg))
        run(['runuser', '-u', 'dsh', '--', NODE, str(SOURCE / PATCH_FILES[0]), '--check', *map(str, packages)])
        unchanged = [p for p, old in originals.items() if old and p not in installed]
        check(all(p.read_bytes() == originals[p]['raw'] for p in unchanged))
        stage = 'start-and-verify'
        run(['systemctl', 'start', 'qqai-dsh.service']); stopped = False
        after = previous.wait_online(q)
        check(unrelated(after['config']) == unrelated(before['config']))
        check(unrelated(json.loads(config_path.read_bytes())) == unrelated(cfg))
        check(after['config']['ext']['qqai-compat']['stickerUsage'] == 'often')
        end = time.monotonic() + 25
        while True:
            try:
                policy = q.fetch_json(q.connect(), '/aurabot/api/ext/qqai-compat/sticker-state')
                if policy.get('usage') == 'often': break
            except Exception: pass
            check(time.monotonic() < end); time.sleep(1)
        check(policy.get('maxImagesPerTurn') == 2 and policy.get('allowedPack') == '大肥鱼')
        modules = after.get('modules', []); modules = modules.get('list', []) if isinstance(modules, dict) else modules
        for name in MODULES:
            item = next(x for x in modules if x['id'] == name)
            check(item.get('running') == 'user' and item.get('enabled') is True and not item.get('error'))
        check(json.loads(run(['docker', 'inspect', 'qqai-dsh-snowluma']))[0]['State']['StartedAt'] == gateway)
        check(run(['systemctl', 'show', 'qqai-dsh.service', '--property=InvocationID', '--value']).strip() != invocation)
        result.update(ok=True, at=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(),
            dshRestarted=True, gatewayProcessUnchanged=True, qqReconnected=True,
            backupRestoreVerified=True, backupFiles=sum(v is not None for v in originals.values()),
            unrelatedConfigUnchanged=True, policy=policy,
            bytePreserved={str(p.relative_to(DATA)): p.read_bytes() == originals[p]['raw']
                for p in unchanged if p.is_relative_to(DATA)},
            codeSha256={str(p): sha(p.read_bytes()) for p in installed if p.suffix in ('.js', '.mjs')})
    except Exception as error:
        result.update(stage=stage, error='sticker-deployment-failed-private-details-omitted',
            errorType=type(error).__name__, errorFrames=[{'file': Path(x.filename).name, 'line': x.lineno}
                for x in traceback.extract_tb(error.__traceback__)])
        if installed:
            try:
                run(['systemctl', 'stop', 'qqai-dsh.service']); stopped = True
                for path in reversed(installed):
                    old = originals[path]
                    if old is None:
                        if path.exists(): path.unlink()
                        continue
                    raw = old['raw']
                    if path == config_path:
                        current = json.loads(path.read_bytes()); prior = json.loads(raw)['ext']['qqai-compat']
                        if 'stickerUsage' in prior: current['ext']['qqai-compat']['stickerUsage'] = prior['stickerUsage']
                        else: current['ext']['qqai-compat'].pop('stickerUsage', None)
                        raw = (json.dumps(current, ensure_ascii=False, indent=2)+'\n').encode()
                    elif path == profile_path:
                        raw = profile_update(path.read_bytes(), restore_from=old['raw'])
                    helper.atomic_write(path, raw, uid=old['uid'], gid=old['gid'], mode=old['mode'])
                result['codeAndTargetedConfigRolledBack'] = True
            except Exception: result['rollbackNeedsReview'] = True
        if stopped:
            try:
                run(['systemctl', 'start', 'qqai-dsh.service']); previous.wait_online(q)
                result['previousServiceRestored'] = True
            except Exception: result['serviceNeedsReview'] = True
    helper.save_private(record, 'result.json', result)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
