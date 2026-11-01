#!/usr/bin/env python3
"""Drive installed qqai-neko-probe using synthetic DSH sessions and real models.

Run on the server. --send-qq additionally requests two one-time owner deliveries:
one stock/template sample message and one scheduled reminder in a separate store.
Output is metadata only; credentials, model prose and tool bodies remain private.
"""
import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import re
import time
import urllib.request
import uuid

PREFIX = 'qqai-synthetic-stickers-'
PROBE = '/aurabot/api/ext/qqai-neko-probe'
CASES = [
    ('happy', '我刚才 CS2 连输好几把，最后一把终于翻盘赢啦！现在有点得意，哈哈。'),
    ('hungry', '还没吃饭，肚子咕咕叫……你是不是也在惦记那碗米饭呀？'),
    ('joke', '我们刚给“只打最后一把但一直没下线”取了个名字：最后一把委员会。现在我宣布委员会散会，哈哈，你有什么感想？'),
    ('praise', '今天你把事情处理得很认真，小鲸真棒！给你多盛一碗米饭。'),
    ('stock', '请从大肥鱼现成表情库里找一张适合庆祝胜利的动画表情发给我，不制作文字模板。'),
    ('template', '请做一张大肥鱼举牌的文字表情，牌子上完整写“今天也要开心”。'),
    ('plain', '这次只回复纯文字，不要图片或表情。告诉我 17 加 25 等于多少。'),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--send-qq', action='store_true')
    parser.add_argument('--inspector', default='/opt/qqai-dsh/source/scripts/inspect-qq-runtime.py')
    args = parser.parse_args()
    os.umask(0o077)
    output = Path(args.output)
    if not output.is_absolute() or output.is_symlink():
        raise ValueError('output must be a new protected absolute file')
    spec = importlib.util.spec_from_file_location('qqai_inspect', args.inspector)
    q = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(q)
    opener = q.connect()

    def request(path, body=None, test=False):
        headers = {'Content-Type': 'application/json'}
        if test:
            headers['X-QQAI-Acceptance'] = 'neko-stickers-v1'
        req = urllib.request.Request(q.ORIGIN + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers, method='POST' if body is not None else 'GET')
        with opener.open(req, timeout=60) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError('oversized response')
        return json.loads(raw)

    def rpc(method, values):
        r = request('/api/' + method, {'type': 'client-request', 'rpcId': str(uuid.uuid4()),
            'method': method, 'payload': {'args': values}})['result']
        if not r.get('ok'):
            raise ValueError('RPC failed; private details omitted')
        return r['value']

    state = request(PROBE + '/state')
    if state.get('ok') is not True:
        raise ValueError('acceptance observer is not ready')
    runtime = request('/aurabot/api/state')
    workspace = runtime['config']['workspaceDir']
    if not isinstance(workspace, str) or not workspace.startswith('/srv/qqai-dsh/'):
        raise ValueError('unexpected synthetic workspace')
    evidence = {'scope': 'real DeepSeek in isolated synthetic QQ-preset sessions; QQ receipts separately reported',
        'at': dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(),
        'productionOwnerSessionPrompted': False, 'productionMemoryToolsAllowed': False,
        'qqDeliveryRequested': args.send_qq, 'cases': []}

    def save():
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp = output.with_name(output.name + '.tmp')
        if temp.is_symlink():
            raise ValueError('unsafe temporary output')
        temp.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
        os.chmod(temp, 0o600)
        temp.replace(output)

    for label, prompt in CASES:
        desired = PREFIX + label + '-' + uuid.uuid4().hex
        created = rpc('session/create', {'request': {'cwd': workspace, 'agentPreset': 'aurabot-private', 'sessionId': desired}})
        session_id = created['sessionId']
        normalized = re.sub(r'^session-', '', session_id)
        if normalized != desired:
            raise ValueError('synthetic session identity mismatch')
        rpc('session/selectModel', {'request': {'sessionId': session_id,
            'provider': 'deepseek-official', 'model': 'deepseek-flash', 'reasoningEffort': 'off'}})
        rpc('session/prompt', {'request': {'sessionId': session_id, 'requestId': str(uuid.uuid4()),
            'mode': 'queue', 'clientTimeZone': 'Asia/Shanghai', 'content': [{'type': 'text', 'text': prompt}]}})
        end = time.monotonic() + 180
        result = None
        while time.monotonic() < end:
            time.sleep(1)
            current = request(PROBE + '/state')
            item = current.get('cases', {}).get(normalized, {})
            if item.get('terminal'):
                result = item
                break
        if result is None:
            rpc('session/cancel', {'request': {'sessionId': session_id}})
            result = {'completed': False, 'terminal': 'timeout'}
        evidence['cases'].append({'case': label, **result})
        save()
        print(json.dumps({'case': label, 'completed': result.get('completed'),
            'imagesInModelReply': result.get('outputImages', 0)}, ensure_ascii=False), flush=True)

    current = request(PROBE + '/state')
    evidence['observerErrors'] = current['observerErrors']
    evidence['blockedNonStickerToolAttempts'] = current['deniedTools']
    evidence['realModelArtifactCounts'] = current['artifactCounts']
    observed_requests = [request for case in evidence['cases'] for request in case.get('actualRequests', [])]
    requests = [request for request in observed_requests if request.get('kind') == 'agent-dialogue']
    evidence['actualRequestCounts'] = {'agentDialogue': len(requests),
        'auxiliary': sum(request.get('kind') == 'auxiliary' for request in observed_requests)}
    natural_cases = [case for case in evidence['cases'] if case['case'] in ('happy', 'hungry', 'joke', 'praise')]
    evidence['observations'] = {
        'naturalCasesUsedArtwork': any(case.get('outputImages', 0) > 0 for case in natural_cases),
        'naturalCasesObserved': len(natural_cases),
        'naturalCasesWithArtwork': sum(case.get('outputImages', 0) > 0 for case in natural_cases),
        'normalAllowsNoImage': True,
        'naturalSelectionIsNotAnAcceptanceGate': True,
    }
    evidence['checks'] = {
        'allCasesCompleted': all(c.get('completed') for c in evidence['cases']),
        'allActualRequestsFlashThinkingOff': bool(requests) and all(r['provider'] == 'deepseek-official'
            and r['model'] == 'deepseek-flash' and r['thinkingOff'] for r in requests),
        'actualLlmRequestObservedForEveryCase': all(any(r.get('kind') == 'agent-dialogue'
            for r in c.get('actualRequests', [])) for c in evidence['cases']),
        'actualNekoToolsAvailable': bool(requests) and all(set(r.get('actualTools', []))
            == {'sticker_search', 'sticker_send', 'meme_render', 'sticker_manage'} for r in requests),
        'actualFinalSystemContainsPolicy': bool(requests) and all(r['policyInActualSystem'] for r in requests),
        'actualPersonaPreserved': bool(requests) and all(r['personaInActualSystem'] for r in requests),
        'explicitTemplateReturnedImage': any(c.get('templateImages', 0) > 0 for c in evidence['cases'] if c['case'] == 'template'),
        'explicitStockReturnedImage': any(c.get('stockImages', 0) > 0 for c in evidence['cases'] if c['case'] == 'stock'),
        'plainTextRequestHasNoImages': all(c.get('outputImages', 0) == 0 for c in evidence['cases'] if c['case'] == 'plain'),
        'modelRepliesWithinTwoImages': all(c.get('outputImages', 0) <= 2 for c in evidence['cases']),
    }
    evidence['coreChecksPassed'] = all(evidence['checks'].values()) and evidence['observerErrors'] == 0
    save()
    if args.send_qq and evidence['coreChecksPassed']:
        evidence['mediaDelivery'] = request(PROBE + '/media-test', {}, test=True)
        save()
        evidence['reminderCreation'] = request(PROBE + '/reminder-test', {}, test=True)
        save()
        end = time.monotonic() + 65
        while time.monotonic() < end:
            time.sleep(1)
            current = request(PROBE + '/state')
            if current.get('reminderTest', {}).get('finishedAt'):
                break
        evidence['reminderDelivery'] = current.get('reminderTest', {})
        evidence['reminderEngine'] = current.get('reminderEngine', {})
        save()
    elif args.send_qq:
        evidence['qqDeliverySkipped'] = 'core-model-or-prompt-checks-failed'
        save()
    evidence['passed'] = evidence['coreChecksPassed'] and (not args.send_qq or (
        evidence.get('mediaDelivery', {}).get('receiptConfirmed') is True
        and evidence.get('reminderDelivery', {}).get('receiptConfirmed') is True
        and 1 <= evidence.get('reminderDelivery', {}).get('images', 0) <= 2))
    save()
    print(json.dumps({'finished': True, 'checks': evidence['checks'],
        'mediaReceiptConfirmed': evidence.get('mediaDelivery', {}).get('receiptConfirmed'),
        'reminderReceiptConfirmed': evidence.get('reminderDelivery', {}).get('receiptConfirmed')}, ensure_ascii=False))
    return 0 if evidence['passed'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print(json.dumps({'error': 'acceptance-driver-failed-private-details-omitted'}))
        raise SystemExit(1)
