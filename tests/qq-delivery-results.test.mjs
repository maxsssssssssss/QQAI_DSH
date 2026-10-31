// Automated regression of the pinned implementation, not QQ delivery acceptance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { QQ_DELIVERY_PATCHES, patchedDeliverySource } from '../scripts/qq-delivery-patch-spec.mjs'
import { PATCHES, GIF_MEDIA_PATCH, patchedSource } from '../scripts/patch-plugin-media.mjs'

const root = process.env.AURABOT_SOURCE_ROOT
const dataModule = (source) => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
async function patched(t, index) {
  if (!root) { t.skip('Set AURABOT_SOURCE_ROOT to the fixed Aurabot package'); return }
  const spec = QQ_DELIVERY_PATCHES[index]
  const composed = PATCHES.find((entry) => entry.file === spec.file)
  return patchedSource(await readFile(join(root, spec.file), 'utf8'), composed)
}
function functionText(source, name, endMarker) {
  const start = source.indexOf(`  async function ${name}(`)
  const end = source.indexOf(endMarker, start)
  assert.ok(start > 0 && end > start)
  return source.slice(start, end)
}
async function deliveryFixture(source, options = {}) {
  const { parseReply, bubbleDelay } = await dataModule(await readFile(join(root, 'src/chat/reply.js'), 'utf8'))
  const calls = [], logs = [], activities = [], sleeps = []
  const config = { enabled: true, dryRun: false, ownerQQ: '12345', voice: { enabled: false }, stickers: { enabled: false } }
  const make = new Function('parseReply', 'bubbleDelay', 'getConfig', 'sendText', 'sendImage', 'sleep', 'logChat', 'onActivity', `
    const hooks = {}, log = {info(){},warn(){},debug(){}}, mood = () => ({delay:1});
    const groupEngaged = new Map(), groupRefs = new Map(), groupSaid = new Map(), saidElsewhere = new Map();
    const stickers = {}; let lastChatAt = 0, lastBotToOwner = null;
    const sendVoice = async () => true, sendSticker = async () => true, pokeBack = async () => {};
    ${functionText(source, 'deliver', '\n  // ---------- 盯 DSH')}
    return {deliver, state:()=>({lastChatAt,lastBotToOwner})};`)
  const send = (kind) => async (_chat, value) => {
    calls.push({kind,value})
    return options.failAll || (kind === 'image' && options.failImage) ? null : {message_id: String(calls.length)}
  }
  const hub = make(parseReply, bubbleDelay, () => config, send('text'), send('image'),
    async (ms) => sleeps.push(ms), (...args) => logs.push(args), (value) => activities.push(value))
  return {...hub,calls,logs,activities,sleeps}
}

test('native sendSegments does not count missing receipts or failures as sent', async (t) => {
  const source = await patched(t, 0); if (!source) return
  const counts = { sent: 0, errors: 0 }, sentIds = new Set()
  let result, thrown = null
  const config = {enabled: true, dryRun: false}
  const make = new Function('getConfig', 'onebot', 'bump', 'sentIds', `
    const hooks={}, captureStore={getStore:()=>null}, log={info(){},warn(){}};
    const targetOf=()=>({kind:'private',id:'12345'});
    ${functionText(source, 'sendSegments', '\n  /** replyId')}
    return sendSegments;`)
  const send = make(() => config, {call:async()=>{if(thrown)throw thrown; return result}}, (key)=>counts[key]++, sentIds)
  for (result of [undefined, null, {}, {message_id:null}, {message_id:''}, {message_id:false}, {message_id:NaN}]) {
    assert.equal(await send('private:12345', [], 'synthetic'), null)
  }
  thrown = new Error('synthetic transport failure')
  assert.equal(await send('private:12345', [], 'synthetic'), null)
  thrown = null
  assert.equal(counts.sent, 0); assert.equal(counts.errors, 8); assert.equal(sentIds.size, 0)
  result = {message_id: -42}
  assert.deepEqual(await send('private:12345', [], 'synthetic'), result)
  assert.equal(counts.sent, 1); assert.ok(sentIds.has('-42'))
  config.dryRun = true
  assert.equal(await send('private:12345', [], 'synthetic'), null)
  assert.equal(counts.sent, 1)
})

test('native deliver preserves text/GIF/text order and delays while reporting a failed GIF', async (t) => {
  const source = await patched(t, 0); if (!source) return
  const hub = await deliveryFixture(source, {failImage:true})
  const r = await hub.deliver('private:12345', '先说一句|||![表情](https://synthetic.invalid/a.gif)|||再说一句', {own:true})
  assert.deepEqual(r, {ok:false,delivered:2,failed:1,unverified:0,missedAt:[]})
  assert.deepEqual(hub.calls.map(x=>x.kind), ['text','image','text'])
  assert.equal(hub.sleeps.length, 2)
  assert.ok(hub.sleeps.every(ms=>ms>=560&&ms<=5850))
  assert.equal(hub.logs[0][2], '先说一句 再说一句')
  assert.equal(hub.activities[0].reply, '先说一句 再说一句')
})

test('native deliver records only confirmed sends and does not declare unsupported result types successful', async (t) => {
  const source = await patched(t, 0); if (!source) return
  const hub = await deliveryFixture(source, {failAll:true})
  assert.deepEqual(await hub.deliver('private:12345', '没有送达'), {ok:false,delivered:0,failed:1,unverified:0,missedAt:[]})
  assert.equal(hub.logs.length, 0); assert.equal(hub.activities.length, 0)
  assert.deepEqual(hub.state(), {lastChatAt:0,lastBotToOwner:null})
  assert.deepEqual(await hub.deliver('private:12345', '<poke>'), {ok:false,delivered:0,failed:0,unverified:1,missedAt:[]})
  const success = await deliveryFixture(source)
  assert.deepEqual(await success.deliver('private:12345', '甲|||乙'), {ok:true,delivered:2,failed:0,unverified:0,missedAt:[]})
  assert.equal(success.logs[0][2], '甲 乙')
})

test('actual qq_send_message reports failed/partial/blocked sends and remains owner-only with empty allowlists', async (t) => {
  const source = await patched(t, 1); if (!source) return
  const tools = await dataModule(await readFile(join(root, 'src/tools/tools.js'), 'utf8'))
  const moduleSource = source.replace(/^import .*$/gm, '').replace('export default', 'return')
  const definition = new Function('defineTool','str','int','parseMessageEvent', moduleSource)(tools.defineTool,tools.str,tools.int,()=>{})
  let factory, result, deliveries=0
  const cfg = {ownerQQ:'12345',allow:{private:[],groups:[]},files:{enabled:false}}
  definition.setup({core:{hub:{deliver:async()=>{deliveries++;return result}},onebot:{}},config:()=>cfg,tool:fn=>factory=fn})
  const list=factory({chat:{kind:'private',chatId:'private:12345',userId:'12345'},level:'full'})
  assert.ok(!list.some(x=>x.name==='qq_send_file'))
  const send=list.find(x=>x.name==='qq_send_message')
  for(result of [undefined,{ok:false,delivered:0,failed:1},{ok:false,delivered:1,failed:1}]) {
    const response=await send.execute({target:'private:12345',text:'synthetic'})
    assert.equal(response.ok,false); assert.ok(!response.message.includes('发出去了'))
  }
  const before=deliveries
  assert.equal((await send.execute({target:'private:54321',text:'synthetic'})).ok,false)
  assert.equal((await send.execute({target:'group:12345',text:'synthetic'})).ok,false)
  assert.equal(deliveries,before)
  result={ok:true,delivered:2,failed:0,unverified:0,missedAt:[]}
  assert.deepEqual(await send.execute({target:'private:12345',text:'synthetic'}),{ok:true,message:'网关已接受 2 条消息'})
})

test('delivery patch is hash-locked and idempotent', async (t) => {
  for(let i=0;i<QQ_DELIVERY_PATCHES.length;i++) {
    const final=await patched(t,i); if(!final)return
    const spec=QQ_DELIVERY_PATCHES[i]
    const original=await readFile(join(root,spec.file),'utf8')
    const delivery=patchedDeliverySource(i===0?patchedSource(original,GIF_MEDIA_PATCH):original,spec)
    assert.equal(patchedDeliverySource(delivery,spec),delivery)
    assert.throws(()=>patchedDeliverySource(delivery+'drift',spec),/unreviewed delivery source/)
    // Later memory-limit stages must preserve the reviewed delivery-stage upgrade path.
    const composed=PATCHES.find(x=>x.file===spec.file)
    assert.equal(patchedSource(delivery,composed),final)
  }
})
