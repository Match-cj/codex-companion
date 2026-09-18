import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { finalImagePaths, imageSignatureMatches, readRelayImage, relayFinalImages, validateImageRoot, IMAGE_LIMIT } from '../image-relay.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTWQAAAAASUVORK5CYII=', 'base64');
const markdown = file => `![result](<${file}>)`;
test('only explicit absolute Markdown images; no URLs, relative links, SVG or UNC', () => {
  const file = path.join(os.tmpdir(), 'result one.png');
  assert.deepEqual(finalImagePaths(`${markdown(file)} ${markdown(file)} ![x](https://example.com/a.png) ![x](a.png) ![x](//server/a.png) [x](${file}) ![x](${file}.svg)`), [file]);
  assert.equal(finalImagePaths(Array.from({length:9},(_,i)=>markdown(path.join(os.tmpdir(),`${i}.png`))).join('\n')).length,6);
});
test('magic-byte checks reject renamed non-images', () => {
  assert(imageSignatureMatches(png,'.png')); assert(!imageSignatureMatches(Buffer.from('secret text'),'.png')); assert(!imageSignatureMatches(png,'.jpg'));
});
test('bounded reading, directory containment, disabled relay, duplicate content and partial failures', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cc-relay-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const allowed=path.join(root,'allowed');await fs.mkdir(allowed);
  const one=path.join(allowed,'one.png'),two=path.join(allowed,'two.png'),outside=path.join(root,'outside.png'),bad=path.join(allowed,'bad.png'),huge=path.join(allowed,'huge.png');
  for(const file of [one,two,outside])await fs.writeFile(file,png);
  await fs.writeFile(bad,'not image');const handle=await fs.open(huge,'w');await handle.truncate(IMAGE_LIMIT+1);await handle.close();
  assert.equal((await readRelayImage(one,allowed)).bytes.length,png.length);
  await assert.rejects(readRelayImage(outside,allowed));await assert.rejects(readRelayImage(bad,allowed));await assert.rejects(readRelayImage(huge,allowed));await assert.rejects(validateImageRoot(path.parse(root).root));
  const link=path.join(allowed,'escape');await fs.symlink(root,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(readRelayImage(path.join(link,'outside.png'),allowed));
  let sent=0,reports=0;const options={text:[one,two,outside].map(markdown).join('\n'),root:allowed,send:async()=>sent++,report:async()=>reports++};
  assert.deepEqual(await relayFinalImages({...options,enabled:false}),{sent:0,failed:0});assert.equal(sent,0);
  assert.deepEqual(await relayFinalImages({...options,enabled:true}),{sent:1,failed:1});assert.equal(sent,1);assert.equal(reports,1);
  assert.deepEqual(await relayFinalImages({...options,text:markdown(one),enabled:true,send:async()=>{throw Error('API denied')}}),{sent:0,failed:1});
});
test('backend relay uses current completed final message, not commentary or previous turns',async()=>{
  const source=await fs.readFile(new URL('../server.mjs',import.meta.url),'utf8');const notices=[];
  const task={id:'A',status:'running',output:'old output',turnFinalText:'old image',stopRequested:true};
  const c={Date,tasks:new Map([['A',task]]),pendingApprovals:new Map(),trim:s=>s,dashboardLink:()=>'',notifyTurnResult:async(text,options)=>notices.push(options),finishDesktopTakeover:async()=>{},refreshQuotaAfterTask:async()=>{},console};
  vm.createContext(c);vm.runInContext('this.Engine=class {'+source.slice(source.indexOf('  receive(line) {',source.indexOf('class CodexServer {')),source.indexOf('  respondApproval('))+'}',c);
  const engine=new c.Engine();engine.pending=new Map();engine.turns=new Map();
  const emit=(method,params)=>engine.receive(JSON.stringify({method,params:{threadId:'A',...params}}));
  emit('turn/started',{turn:{id:'turn-1'}});
  emit('item/agentMessage/delta',{delta:'intermediate image'});
  emit('item/completed',{item:{type:'agentMessage',phase:'commentary',text:'not final'}});
  emit('item/completed',{item:{type:'agentMessage',phase:'final_answer',text:'new final'}});
  emit('turn/completed',{turn:{id:'turn-1',status:'completed'}});
  assert.equal(notices[0].finalText,'new final');assert.equal(task.stopRequested,false);
  emit('turn/started',{turn:{id:'turn-2'}});
  emit('item/agentMessage/delta',{delta:'another intermediate image'});
  emit('turn/completed',{turn:{id:'turn-2',status:'completed'}});
  assert.equal(notices[1].finalText,'');
});
test('Feishu SDK upload shape and reply mapping preserve originating thread',async()=>{
  const source=await fs.readFile(new URL('../server.mjs',import.meta.url),'utf8');let uploaded=0,replied=0;
  const c={config:{},saveConfig:async()=>{},feishuClient:{im:{v1:{image:{create:async payload=>{uploaded++;assert.equal(payload.data.image_type,'message');return {image_key:'key'}}},message:{reply:async payload=>{replied++;assert.equal(payload.path.message_id,'notice');assert.equal(JSON.parse(payload.data.content).image_key,'key');return {code:0,data:{message_id:'image-message'}}}}}}}};
  vm.createContext(c);vm.runInContext(source.slice(source.indexOf('async function sendFeishuResultImage('),source.indexOf('async function notifyTurnResult(')),c);
  await c.sendFeishuResultImage(png,'notice','thread-A');assert.equal(uploaded,1);assert.equal(replied,1);assert.equal(c.config.feishuMessageThreads['image-message'],'thread-A');
});
test('image relay is gated by successful mapped notice and completed-turn dedupe',async()=>{
  const source=await fs.readFile(new URL('../server.mjs',import.meta.url),'utf8');let relays=0,fresh=true,notice={ok:true,messageId:'notice'};
  const c={config:{feishuImageRelayEnabled:true,feishuImageRelayRoot:'root'},markCodexTurnComplete:async()=>fresh,notify:async()=>notice,relayFinalImages:async opts=>{relays++;assert.equal(opts.text,'final');assert.equal(opts.enabled,true)},sendFeishuResultImage:async()=>{},pushHistory:()=>{},saveConfig:async()=>{}};
  vm.createContext(c);vm.runInContext(source.slice(source.indexOf('async function notifyTurnResult('),source.indexOf('\n}',source.indexOf('async function notifyTurnResult('))+2),c);
  const options={taskId:'A',turnId:'turn',finalText:'final'};
  await c.notifyTurnResult('text',options);assert.equal(relays,1);
  fresh=false;await c.notifyTurnResult('text',options);assert.equal(relays,1);
  fresh=true;notice={ok:false,reason:'muted'};await c.notifyTurnResult('text',options);assert.equal(relays,1);
  notice={ok:true};await c.notifyTurnResult('text',options);assert.equal(relays,1);
});
