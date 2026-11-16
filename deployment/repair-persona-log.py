#!/usr/bin/env python3
"""Repair the three known out-of-step persona updates, preserving every message.

The complete compressed log is backed up and reconstructed before replacement.
The pinned DSH V4 decoder and surface fold validate the repaired artifact.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
from compression import zstd

ROOT = Path('/opt/qqai-dsh/source')
DATA = Path('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot')
NODE = '/opt/qqai-dsh/node-v24.22.2-linux-x64/bin/node'


def main():
    os.umask(0o077)
    helper = runpy.run_path(str(ROOT / 'deployment/set-proactive.py'))
    inspector = helper['inspector']()
    record = helper['private_record_dir']('/var/lib/qqai-dsh/maintenance/20261117-persona-log-recovery')
    mapping = (DATA / 'sessions.json').read_bytes()
    sid = next(iter(json.loads(mapping)['chats'].values()))['sessionId']
    path = DATA.parents[1] / 'sessions/--srv-qqai-dsh-workspace--' / sid / 'session.v4.jsonl.zstd'
    assert path.resolve() == path
    original = path.read_bytes()
    assert hashlib.sha256(original).hexdigest() == '176f1340334f0604719ca20e7206511594b33ade356f6915fd3850d1e37cc8a4'
    raw = zstd.decompress(original)
    rows = [json.loads(x) for x in raw.splitlines()]
    events = rows[1:]
    assert not rows[0]['isSeeded'] and all(e['seq'] == i for i, e in enumerate(events))
    updated = json.loads(json.dumps(events))
    # Move only the closing markers across the administrative system updates.
    # Message order is identical. System updates acquire the actual open step.
    groups = [(6395, 6396, [6397, 6398]), (6483, 6484, [6485])]
    remap = {}
    for step_end, turn_end, systems in groups:
        assert updated[step_end]['type'] == 'step/end' and updated[turn_end]['type'] == 'turn/end'
        assert systems == list(range(turn_end + 1, systems[-1] + 1))
        closing = updated[step_end:turn_end + 1]
        edits = updated[systems[0]:systems[-1] + 1]
        assert all(e['type'] == 'system/message' and isinstance(e.get('surfaceOp'), dict) for e in edits)
        for e in edits:
            e['data']['turn'] = closing[0]['data']['turn']
            e['data']['step'] = closing[0]['data']['step']
        ordered = edits + closing
        for new_seq, e in enumerate(ordered, step_end):
            remap[e['seq']] = new_seq
        updated[step_end:systems[-1] + 1] = ordered
    for i, e in enumerate(updated):
        e['seq'] = i
        if 'sourceEventSeqs' in e:
            e['sourceEventSeqs'] = [remap.get(n, n) for n in e['sourceEventSeqs']]
        if isinstance(e.get('surfaceOp'), dict):
            for k in ('startSeq', 'endSeq'):
                e['surfaceOp'][k] = remap.get(e['surfaceOp'][k], e['surfaceOp'][k])
    assert [{k:v for k,v in e.items() if k != 'seq'} for e in updated if e['type'] != 'system/message'] == [
        {k:v for k,v in e.items() if k != 'seq'} for e in events if e['type'] != 'system/message']
    assert [e['data']['message'] for e in updated if e['type'] == 'system/message'] == [
        e['data']['message'] for e in events if e['type'] == 'system/message']
    helper['save_private'](record, 'original.jsonl', raw, raw=True)
    patched = ('\n'.join(json.dumps(e, ensure_ascii=False, separators=(',', ':')) for e in [rows[0], *updated]) + '\n').encode()
    helper['save_private'](record, 'repaired.jsonl', patched, raw=True)
    validator = r'''import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {KNOWN_SESSION_EVENT_TYPES,foldSurface,deriveEventMessage} from '/opt/qqai-dsh/app/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import {restoreReleasedV4Artifact,releasedV4SessionFormatCodec} from '/opt/qqai-dsh/app/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js';
const read=p=>{const r=readFileSync(p,'utf8').trim().split('\n').map(JSON.parse);return {header:releasedV4SessionFormatCodec.decodeHeader(r[0]),events:r.slice(1),inheritedEventCount:0}};
const a=read(process.argv[2]),b=read(process.argv[3]);
assert.throws(()=>restoreReleasedV4Artifact(a,KNOWN_SESSION_EVENT_TYPES),/system\/message does not match an open turn and step/);
restoreReleasedV4Artifact(b,KNOWN_SESSION_EVENT_TYPES);
const msgs=a=>{const s=foldSurface(a.events);return s.nodes.map(n=>deriveEventMessage(a.events[n],s.projectedMessages)).filter(Boolean)};
const am=msgs(a),bm=msgs(b);assert.deepEqual(am,bm);assert.equal(a.events.length,b.events.length);
console.log(JSON.stringify({nativeV4Validation:true,allProjectedMessagesIdentical:true,events:b.events.length,messages:bm.length,nonSystemMessages:bm.filter(m=>m.role!=='system').length}));'''
    (record / 'validate.mjs').write_text(validator)
    test = subprocess.run([NODE, str(record / 'validate.mjs'), str(record / 'original.jsonl'), str(record / 'repaired.jsonl')], capture_output=True, text=True)
    if test.returncode:
        print(json.dumps({'ok':False,'stage':'offline-validation','recordDir':str(record)}))
        helper['save_private'](record, 'validation-error.private.txt', test.stderr.encode(), raw=True)
        return 1
    evidence = json.loads(test.stdout)
    # DSH requires an independent checksummed frame for the header, followed
    # by independent event-batch frames. A single compressed document is invalid.
    compressor = r"""
import fs from 'node:fs';
import { zstdCompressSync, constants } from 'node:zlib';
const lines = fs.readFileSync(0, 'utf8').trimEnd().split('\n');
const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const frame = text => zstdCompressSync(Buffer.from(text), options);
process.stdout.write(frame(lines.shift() + '\n'));
for (let index = 0; index < lines.length; index += 100) {
    process.stdout.write(frame(lines.slice(index, index + 100).join('\n') + '\n'));
}
"""
    compressed = subprocess.check_output([NODE, '--input-type=module', '-e', compressor], input=patched)
    assert zstd.decompress(compressed) == patched
    subprocess.run(['systemctl','stop','qqai-dsh.service'],check=True,capture_output=True,timeout=60)
    try:
        assert path.read_bytes() == original and (DATA / 'sessions.json').read_bytes() == mapping
        helper['save_private'](record, 'session.before.jsonl.zstd', original, raw=True)
        helper['save_private'](record, 'restore-check.jsonl.zstd', (record/'session.before.jsonl.zstd').read_bytes(), raw=True)
        assert (record/'restore-check.jsonl.zstd').read_bytes() == original
        st=path.stat()
        helper['atomic_write'](path,compressed,uid=st.st_uid,gid=st.st_gid,mode=st.st_mode & 0o777)
    finally:
        subprocess.run(['systemctl','start','qqai-dsh.service'],check=True,capture_output=True,timeout=60)
    prior=runpy.run_path(str(ROOT/'deployment/update-native-proactive.py'))
    prior['wait_online'](inspector)
    prior['check_idle'](inspector,inspector.connect())
    assert (DATA/'sessions.json').read_bytes()==mapping
    evidence.update(ok=True,recordDir=str(record),outOfStepEventsRepaired=3,eventsRemoved=0,
        originalSessionMappingPreserved=True,backupRestoreVerified=True,qqOnline=True,
        originalCompressedSha256=hashlib.sha256(original).hexdigest(),repairedCompressedSha256=hashlib.sha256(compressed).hexdigest(),
        at=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat())
    helper['save_private'](record,'result.json',evidence)
    print(json.dumps(evidence))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
