#!/usr/bin/env python3
"""Set QQ-only high reasoning and fixed 70-minute native scheduling.

Run as root from this project's source. Snapshot private configuration/state,
verify restore copies, change only provider policy and chat/schedule settings,
then restart DSH once. The existing QQ gateway stays connected.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import time
import traceback

SOURCE = Path('/opt/qqai-dsh/source')
DATA = Path('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot')
PROFILE = DATA.parents[1] / 'profiles/web/cordis.patch.yml'
SELECTION = {'provider': 'deepseek-official', 'model': 'deepseek-flash', 'reasoningEffort': 'high'}


def check(value):
    if not value:
        raise ValueError('thinking-and-frequency-verification-failed')


def unrelated(cfg):
    result = json.loads(json.dumps(cfg))
    for key in ('minIntervalMinutes', 'maxIntervalMinutes'):
        result['speakUp'].pop(key, None)
    for key in ('privateDefault', 'groupDefault'):
        result['chatModels'].pop(key, None)
    return result


def run(args):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=60)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record-dir', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    check(os.geteuid() == 0)
    helper = runpy.run_path(str(SOURCE / 'deployment/set-proactive.py'))
    files = runpy.run_path(str(SOURCE / 'deployment/install-reminders.py'))
    prior = runpy.run_path(str(SOURCE / 'deployment/update-native-proactive.py'))
    inspector = helper['inspector']()
    record = helper['private_record_dir'](args.record_dir)
    result = {'ok': False, 'recordDir': str(record), 'qqDeliveryRequested': False,
              'gatewayRestarted': False, 'backgroundEffort': 'off'}
    originals = {}
    changed = False
    stopped = False
    stage = 'preflight'
    config_path = DATA / 'config.json'
    schedule_path = DATA / 'speakup.json'
    try:
        live = prior['wait_online'](inspector)
        prior['check_idle'](inspector, inspector.connect())
        cfg = json.loads(config_path.read_bytes())
        check(cfg['model']['model'] == 'deepseek-flash' and cfg['model']['reasoningEffort'] == 'off')
        check(cfg['speakUp']['enabled'] and cfg['speakUp']['idleMinutes'] == 40)
        check(not cfg['chatModels']['privates'] and not cfg['chatModels']['groups'])
        check(helper['purpose_off'](cfg))
        profile = files['read_raw'](PROFILE)
        old_text = profile['raw'].decode()
        marker = '    thinking: disabled\n'
        check(old_text.count(marker) == 1 and "    reasoningEffort: 'off'" in old_text)
        new_text = old_text.replace(marker, '    thinking: enabled\n', 1)
        timezone = run(['timedatectl', 'show', '--property=Timezone', '--value']).decode().strip()
        check(timezone == 'Asia/Shanghai')
        gateway_start = json.loads(run(['docker', 'inspect', 'qqai-dsh-snowluma']))[0]['State']['StartedAt']
        stage = 'stop-and-backup'
        run(['systemctl', 'stop', 'qqai-dsh.service'])
        stopped = True
        check(json.loads(config_path.read_bytes()) == cfg)
        selected = set(DATA.glob('*.json')) | {PROFILE}
        for name in ['modules-data/qqai-heybox-reader/reader-state.json', 'modules-data/qqai-reminders/reminders.json']:
            if (DATA / name).exists():
                selected.add(DATA / name)
        before = files['private_subdir'](record / 'before')
        restored = files['private_subdir'](record / 'isolated-restore')
        inventory = []
        for index, path in enumerate(sorted(selected)):
            item = files['read_raw'](path)
            originals[path] = item
            name = str(index) + '.private'
            for directory in (before, restored):
                helper['save_private'](directory, name, item['raw'], raw=True)
                check((directory / name).read_bytes() == item['raw'])
            if path.suffix == '.json':
                json.loads(item['raw'])
            inventory.append({'path': str(path), 'backup': name,
                'sha256': hashlib.sha256(item['raw']).hexdigest(),
                **{k: item[k] for k in ('uid', 'gid', 'mode')}})
        helper['save_private'](record, 'manifest.private.json', inventory)
        cfg_after = json.loads(json.dumps(cfg))
        cfg_after['chatModels']['privateDefault'] = dict(SELECTION)
        cfg_after['chatModels']['groupDefault'] = dict(SELECTION)
        cfg_after['speakUp'].update(minIntervalMinutes=70, maxIntervalMinutes=70)
        previous_schedule = json.loads(originals[schedule_path]['raw'])
        scheduled_at = int(time.time() * 1000)
        next_schedule = {**previous_schedule, 'nextAt': scheduled_at + 70 * 60_000}
        check(unrelated(cfg_after) == unrelated(cfg))
        stage = 'write-reviewed-settings'
        changed = True
        for path, content in [(PROFILE, new_text.encode()), (config_path, helper['encoded'](cfg_after)),
                              (schedule_path, helper['encoded'](next_schedule))]:
            item = originals[path]
            helper['atomic_write'](path, content, **{k: item[k] for k in ('uid', 'gid', 'mode')})
        check(json.loads(schedule_path.read_bytes()) == next_schedule)
        stage = 'restart-and-verify'
        run(['systemctl', 'start', 'qqai-dsh.service'])
        stopped = False
        after = prior['wait_online'](inspector)
        check(after['config']['chatModels']['privateDefault'] == SELECTION)
        check(after['config']['chatModels']['groupDefault'] == SELECTION)
        check(after['config']['speakUp']['minIntervalMinutes'] == after['config']['speakUp']['maxIntervalMinutes'] == 70)
        check(unrelated(after['config']) == unrelated(live['config']))
        check(json.loads(config_path.read_bytes()) == cfg_after)
        check(PROFILE.read_bytes() == new_text.encode())
        check(json.loads(run(['docker', 'inspect', 'qqai-dsh-snowluma']))[0]['State']['StartedAt'] == gateway_start)
        other_states = {str(p.relative_to(DATA)): p.read_bytes() == v['raw']
                        for p, v in originals.items() if p not in (PROFILE, config_path, schedule_path)}
        # The native recent-media cache expires after 30 minutes on startup.
        # Accept only expired-item removal, preserving every remaining item/order.
        expired_media = 0
        cache_path = DATA / 'recent-media.json'
        if other_states.get('recent-media.json') is False:
            old_media = json.loads(originals[cache_path]['raw'])
            new_media = json.loads(cache_path.read_bytes())
            check(set(new_media) <= set(old_media))
            cutoff = time.time() * 1000 - 30 * 60_000
            for key, items in old_media.items():
                kept = new_media.get(key, [])
                check(all(item in items for item in kept))
                check([item for item in items if item in kept] == kept)
                removed = [item for item in items if item not in kept]
                check(all(isinstance(item.get('at'), (int, float)) and item['at'] <= cutoff for item in removed))
                expired_media += len(removed)
        check(all(v for k, v in other_states.items() if k != 'recent-media.json'))
        current_schedule = json.loads(schedule_path.read_bytes())
        check(current_schedule['nextAt'] == next_schedule['nextAt'])
        check(all(current_schedule.get(k) == previous_schedule.get(k) for k in previous_schedule if k not in ('nextAt', 'day', 'count')))
        rollover = current_schedule.get('day') != previous_schedule.get('day')
        check(current_schedule['count'] == (0 if rollover else previous_schedule['count']))
        check(not any(m.get('error') for m in after.get('modules', []) if m.get('enabled')))
        result.update(ok=True, at=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(),
            qqChat=SELECTION, providerThinking='enabled', providerDefaultEffort='off',
            speakUp={k: after['config']['speakUp'][k] for k in ('enabled', 'maxPerDay', 'minIntervalMinutes',
                'maxIntervalMinutes', 'idleMinutes', 'awakeFrom', 'awakeTo', 'nudge')},
            nextAt=next_schedule['nextAt'], rescheduledAt=scheduled_at, exactIntervalMinutes=70,
            previousDay=previous_schedule['day'], previousCount=previous_schedule['count'],
            day=current_schedule['day'], count=current_schedule['count'], nativeDayRollover=rollover,
            countResetByInstaller=False, backupRestoreVerified=True, backupFiles=len(originals),
            unrelatedConfigPreserved=True, preservedState=other_states, expiredMediaCacheEntriesRemoved=expired_media, qqOnline=True,
            gatewayStartPreserved=True, dshRestarted=True, timezone=timezone)
    except Exception as error:
        result.update(stage=stage, errorType=type(error).__name__,
            errorFrames=[{'file': Path(f.filename).name, 'line': f.lineno}
                         for f in traceback.extract_tb(error.__traceback__)])
        if changed:
            try:
                run(['systemctl', 'stop', 'qqai-dsh.service'])
                stopped = True
                current = json.loads(config_path.read_bytes())
                for k in ('privateDefault', 'groupDefault'):
                    current['chatModels'][k] = cfg['chatModels'][k]
                for k in ('minIntervalMinutes', 'maxIntervalMinutes'):
                    current['speakUp'][k] = cfg['speakUp'][k]
                schedule = json.loads(schedule_path.read_bytes())
                schedule['nextAt'] = previous_schedule['nextAt']
                for path, content in [(PROFILE, profile['raw']), (config_path, helper['encoded'](current)),
                                      (schedule_path, helper['encoded'](schedule))]:
                    item = originals[path]
                    helper['atomic_write'](path, content, **{k: item[k] for k in ('uid', 'gid', 'mode')})
                result['targetedRollbackCompleted'] = True
            except Exception:
                result['rollbackNeedsReview'] = True
        if stopped:
            try:
                run(['systemctl', 'start', 'qqai-dsh.service'])
                prior['wait_online'](inspector)
                result['previousServiceRestored'] = True
            except Exception:
                result['serviceNeedsReview'] = True
    helper['save_private'](record, 'result.json', result)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
