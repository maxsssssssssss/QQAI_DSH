#!/usr/bin/env python3
"""Real DeepSeek checks using only synthetic data; never print/store credentials.

This checks the API transport, not DSH or QQ. Requires explicit key file input.
Search/Fetch are opt-in because their per-request billing begins 2026-11-01 CST.
"""
import argparse
import base64
import hashlib
import json
import secrets
import struct
import time
import urllib.error
import urllib.request
import zlib
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward Authorization to a redirect target.


def color_fixture():
    width, height = 600, 300
    row = b"\x00" + b"\xff\x00\x00" * 200 + b"\x00\xcc\x00" * 200 + b"\x00\x00\xff" * 200
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(row * height)) + chunk(b'IEND', b''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--key-file', required=True, type=Path)
    ap.add_argument('--output', required=True, type=Path)
    ap.add_argument('--include-search-fetch', action='store_true')
    ap.add_argument('--accept-search-fetch-billing', action='store_true')
    args = ap.parse_args()
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    if args.include_search_fetch and now.date().isoformat() >= '2026-11-01' and not args.accept_search_fetch_billing:
        ap.error('Search/Fetch billing requires explicit authorization after 2026-11-01 CST')
    key = args.key_file.read_text(encoding='utf-8-sig').strip()
    if not key.startswith('sk-') or any(c.isspace() for c in key):
        raise SystemExit('API credential file has an unexpected format')
    opener = urllib.request.build_opener(NoRedirect)
    report = {'time': now.isoformat(), 'category': 'real-api-only', 'model_requested': 'deepseek-flash',
              'thinking_requested': 'disabled', 'data': 'synthetic-only', 'checks': [], 'requests': []}

    def save():
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')

    def post(endpoint, body):
        req = urllib.request.Request('https://api.deepseek.com' + endpoint,
                                     data=json.dumps(body).encode(),
                                     headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, method='POST')
        started = time.monotonic()
        try:
            with opener.open(req, timeout=180) as resp:
                result = json.load(resp)
        except urllib.error.HTTPError as e:
            report['requests'].append({'endpoint': endpoint, 'http_status': e.code})
            save()
            raise RuntimeError('DeepSeek HTTP ' + str(e.code)) from None
        report['requests'].append({'endpoint': endpoint, 'http_status': 200,
                                   'seconds': round(time.monotonic() - started, 3),
                                   'model_returned': result.get('model'), 'usage': result.get('usage')})
        save()
        return result

    def check(name, passed, detail):
        record = {'name': name, 'passed': bool(passed), 'detail': detail}
        report['checks'].append(record)
        save()
        print(json.dumps(record, ensure_ascii=False), flush=True)

    def chat(messages, **kwargs):
        result = post('/chat/completions', {'model': 'deepseek-flash', 'messages': messages,
                      'thinking': {'type': 'disabled'}, 'stream': False, 'max_tokens': 1600, **kwargs})
        msg = result['choices'][0]['message']
        if msg.get('reasoning_content'):
            raise RuntimeError('Unexpected reasoning content with Thinking Off')
        return msg

    try:
        marker = '蓝鲸-' + secrets.token_hex(3)
        messages = [{'role': 'user', 'content': '我们做一次中文对话测试。今天我的合成测试代号是' + marker + '，请记住，并用中文简短回应。'}]
        first = chat(messages)
        check('chinese_reply', any('\u4e00' <= c <= '\u9fff' for c in first.get('content', '')), first.get('content', '')[:250])
        messages += [first, {'role': 'user', 'content': '刚才告诉你的测试代号是什么？只返回代号。'}]
        second = chat(messages)
        check('multi_turn_context', marker in second.get('content', ''), second.get('content', '')[:250])

        payload = 'QQAI_DSH synthetic tool input ' + secrets.token_hex(12)
        expected = hashlib.sha256(payload.encode()).hexdigest()
        tool = {'type': 'function', 'function': {'name': 'sha256_text', 'description': 'Actually compute SHA256 of the provided UTF-8 text.',
                'parameters': {'type': 'object', 'properties': {'text': {'type': 'string'}}, 'required': ['text'], 'additionalProperties': False}}}
        messages = [{'role': 'user', 'content': '请调用工具计算以下文本的 SHA256，然后只给出工具返回的十六进制摘要：' + payload}]
        call = chat(messages, tools=[tool], tool_choice='required')
        calls = call.get('tool_calls', [])
        valid = len(calls) == 1 and calls[0]['function']['name'] == 'sha256_text'
        if not valid:
            raise RuntimeError('Unexpected tool call shape')
        fn_args = json.loads(calls[0]['function']['arguments'])
        if fn_args != {'text': payload}:
            raise RuntimeError('Unexpected tool arguments')
        digest = hashlib.sha256(fn_args['text'].encode()).hexdigest()
        messages += [call, {'role': 'tool', 'tool_call_id': calls[0]['id'], 'content': json.dumps({'sha256': digest})}]
        final = chat(messages, tools=[tool], tool_choice='none')
        check('real_function_roundtrip', expected in final.get('content', ''), 'Executed hashlib.sha256 on model-provided arguments; checked final digest.')

        fixture = color_fixture()
        messages = [{'role': 'user', 'content': [
            {'type': 'text', 'text': '请识别图片，从左到右用三个中文颜色名称描述色块，只输出颜色。'},
            {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + base64.b64encode(fixture).decode()}}]}]
        vision = chat(messages)
        content = vision.get('content', '')
        check('real_image_pixels', all(c in content for c in '红绿蓝') and content.index('红') < content.index('绿') < content.index('蓝'), content[:250])
        messages += [vision, {'role': 'user', 'content': '上图正中间的色块是什么颜色？只答一个颜色。'}]
        followup = chat(messages)
        check('image_followup', '绿' in followup.get('content', ''), followup.get('content', '')[:250])
        report['image_sha256'] = hashlib.sha256(fixture).hexdigest()

        if args.include_search_fetch:
            search = post('/v1/tools/search', {'query': 'site:api-docs.deepseek.com deepseek-flash vision', 'count': 3, 'need_content': False})
            results = search.get('results', [])
            check('real_search_endpoint', bool(results), {'result_count': len(results), 'urls': [r.get('url') for r in results]})
            fetch = post('/v1/tools/fetch', {'url': 'https://api-docs.deepseek.com/guides/vision/'})
            check('real_fetch_endpoint', 'deepseek-flash' in fetch.get('content', ''), {'title': fetch.get('title'), 'content_chars': len(fetch.get('content', ''))})
        report['status'] = 'passed' if all(c['passed'] for c in report['checks']) else 'failed'
    except Exception as e:
        report['status'] = 'error'
        report['error_type'] = type(e).__name__  # No raw exception may include request or credentials.
        print('Test stopped; sanitized error type: ' + type(e).__name__, flush=True)
    save()
    raise SystemExit(0 if report['status'] == 'passed' else 1)


if __name__ == '__main__':
    main()
