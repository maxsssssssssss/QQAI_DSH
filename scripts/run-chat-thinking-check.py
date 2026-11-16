#!/usr/bin/env python3
"""Exercise QQ high thinking through a private synthetic session and native tools.

Includes an off-to-high transition, real sticker search, follow-up reasoning,
and a real off background judgment. No QQ delivery or owner prompt.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import pwd
import runpy
import tempfile
import time
import urllib.request
import uuid


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe',type=Path,default=Path(__file__).with_name('verify-qq-thinking.mjs'))
    args=parser.parse_args()
    os.umask(0o077)
    helper=runpy.run_path('/opt/qqai-dsh/source/deployment/set-proactive.py')
    q=helper['inspector']();op=q.connect()
    data=Path('/srv/qqai-dsh/home/.dsh/plugins-data/aurabot')
    record=helper['private_record_dir']('/var/lib/qqai-dsh/maintenance/20261117-thinking-verification')
    code=Path(tempfile.mkdtemp(prefix='qqai-thinking-check-',dir=data/'modules'))
    mid=code.name;sid='qqai-synthetic-stickers-thinking-'+uuid.uuid4().hex
    result={'ok':False,'qqDeliveryRequested':False,'ownerSessionPrompted':False,'recordDir':str(record)}
    active=None
    def request(path,body=None,timeout=45):
        req=urllib.request.Request(q.ORIGIN+path,data=json.dumps(body).encode() if body is not None else None,
            headers={'content-type':'application/json'})
        with op.open(req,timeout=timeout) as response:return json.load(response)
    def rpc(method,values):
        value=request('/api/'+method,{'type':'client-request','rpcId':str(uuid.uuid4()),'method':method,'payload':{'args':values}})['result']
        assert value.get('ok'), 'rpc-failed'
        return value['value']
    before={name:(data/name).read_bytes() for name in ['config.json','sessions.json','memories.json']}
    try:
        module=args.probe.read_text().replace('__MODULE_ID__',mid).replace('__SESSION_ID__',sid)
        (code/'index.mjs').write_text(module)
        user=pwd.getpwnam('dsh')
        for p in [code,code/'index.mjs']:os.chown(p,user.pw_uid,user.pw_gid)
        loaded=request('/aurabot/api/modules/reload',{'id':mid})
        assert loaded.get('ok'), 'probe-load-failed'
        endpoint='/aurabot/api/ext/'+mid
        state=request(endpoint+'/state')
        assert state['owner']['effectiveEffort']=='high'
        cfg=request('/aurabot/api/state')['config']
        created=rpc('session/create',{'request':{'cwd':cfg['workspaceDir'],'agentPreset':'aurabot-private','sessionId':sid}})
        active=created['sessionId'];assert active.removeprefix('session-')==sid
        prompts=[('off','只用一句文字确认：本次合成测试的饮料是海盐汽水。'),
                 ('high','请在大肥鱼表情库搜索一张开心的表情，调用检索工具后告诉我找到的表情名字。这轮只回文字。'),
                 ('high','刚才测试里提到的饮料是什么？只用一句话回答。')]
        result['rounds']=[]
        for count,(effort,prompt) in enumerate(prompts,1):
            if count==2:assert request(endpoint+'/high',{})['effort']=='high'
            start=time.monotonic()
            rpc('session/prompt',{'request':{'sessionId':active,'requestId':str(uuid.uuid4()),'mode':'queue',
                'clientTimeZone':'Asia/Shanghai','content':[{'type':'text','text':prompt}]}})
            while time.monotonic()-start<210:
                state=request(endpoint+'/state')
                ends=[e for e in state['turns'] if e['event']=='end']
                if len(ends)>=count:break
                time.sleep(1)
            assert len(ends)>=count and ends[-1]['reason']=='completed','synthetic-turn-incomplete'
            result['rounds'].append({'effort':effort,'completed':True,'elapsedSeconds':round(time.monotonic()-start,2)})
            print(json.dumps({'round':count,'effort':effort,'completed':True}),flush=True)
        assert request(endpoint+'/background',{},timeout=60)['ok']
        state=request(endpoint+'/state')
        primary=[r for r in state['requests'] if r['kind']=='dialogue']
        assert primary and primary[0]['effort']=='off' and all(r['effort']=='high' for r in primary[1:])
        assert all(r['personaMatches'] for r in primary)
        assert all(r['effort'] in ('off',None) for r in state['requests'] if r['kind']=='auxiliary')
        assert any(r['replayedReasoningBlocks']>0 for r in primary)
        assert any(t['name']=='sticker_search' and t['success'] for t in state['tools'])
        assert any(t.get('reasoningCharacters',0)>0 for t in state['turns'])
        assert any(t.get('containsSyntheticRecall') for t in state['turns'][-2:])
        assert state['defaultEffort']=='off' and state['background']['effort']=='off' and not state['errors']
        result.update(ok=True,observation=state)
    except Exception as e:
        result.update(errorType=type(e).__name__,stage='verification',error=str(e) if isinstance(e,AssertionError) else 'private-details-omitted')
        try:result['observation']=request('/aurabot/api/ext/'+mid+'/state')
        except Exception:pass
        if active:
            try:rpc('session/cancel',{'request':{'sessionId':active}})
            except Exception:pass
    finally:
        code.rename(record/'probe-code')
        request('/aurabot/api/modules/reload',{})
        state=request('/aurabot/api/state')
        result['temporaryModuleUnloaded']=not any(m.get('id')==mid and m.get('running') for m in state.get('modules',[]))
        result['preservedFiles']={name:(data/name).read_bytes()==raw for name,raw in before.items()}
        result['qqOnline']=state['onebot']['state']=='connected'
        result['at']=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat()
        result['ok']=result['ok'] and result['temporaryModuleUnloaded'] and all(result['preservedFiles'].values()) and result['qqOnline']
        helper['save_private'](record,'result.json',result)
    print(json.dumps(result,ensure_ascii=False),flush=True)
    return 0 if result['ok'] else 1


if __name__=='__main__':
    raise SystemExit(main())
