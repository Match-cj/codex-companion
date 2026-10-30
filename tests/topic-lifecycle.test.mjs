import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
function context(){
  const sent=[],history=[];
  const c={config:{feishuBoundChatId:'chat',feishuNotificationThreadMode:'task',feishuTaskTopicRoots:{real:'root'},feishuTaskTopicChats:{real:'chat'}},
    canonicalCodexThreadId:id=>id==='alias'?'real':String(id||''),feishuClient:{},feishuTopicCreationLocks:new Map(),codexSessionTopicsAnnounced:new Set(),
    notificationType:()=>'',notificationEnabled:()=>true,normalizeAppName:v=>v,trim:v=>v,pushHistory:v=>history.push(v),saveConfig:async()=>{},
    inferNotificationTaskId:async(text,id)=>id,console,sendFeishuAppText:async(text,opts)=>{sent.push(opts);return{messageId:'sent'}}};
  vm.createContext(c);
  for(const [a,b] of [['function existingFeishuTaskTopic(', 'function wrapFeishuText('],['async function notify(text,','function quotaLabel('],['function feishuReplyThreadId(', 'async function continueThreadFromFeishu(']])
    vm.runInContext(source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a))),c);
  return {c,sent,history};
}
test('manual desktop continuation and aliases reuse the canonical topic',async()=>{
  const {c,sent}=context();
  assert.equal((await c.notify('result',{taskId:'alias'})).ok,true);
  assert.equal(sent.length,1);assert.equal(sent[0].replyTo,'root');assert.equal(sent[0].taskId,'real');
  c.config.feishuTaskTopicRoots={alias:'alias-root'};c.config.feishuTaskTopicChats={alias:'chat'};
  assert.equal(c.existingFeishuTaskTopic('real'),'alias-root');
});
test('reply transport failure preserves topic and never creates a duplicate',async()=>{
  const {c,sent,history}=context();c.sendFeishuAppText=async(text,opts)=>{sent.push(opts);throw Error('temporary network failure')};
  assert.equal((await c.notify('result',{taskId:'real'})).ok,false);
  assert.equal(sent.length,1);assert.equal(sent[0].replyTo,'root');
  assert.equal(c.config.feishuTaskTopicRoots.real,'root');assert.equal(history[0].sent,false);
});
test('recovered old root repairs outbound route without replacing an existing chosen topic',async()=>{
  const {c}=context();c.config.feishuTaskTopicRoots={};c.config.feishuTaskTopicChats={};
  c.recoverReplyTarget=async()=>({threadId:'real',rootId:'old-root',reason:'bot-root-anchor'});
  assert.equal(await c.resolveFeishuReplyThread({root_id:'old-root'}),'real');
  assert.equal(c.config.feishuTaskTopicRoots.real,'old-root');
  c.config.feishuTaskTopicRoots.real='preferred-root';
  await c.resolveFeishuReplyThread({root_id:'old-root'});
  assert.equal(c.config.feishuTaskTopicRoots.real,'preferred-root');
});
test('explicit reopen removes canonical and alias outbound roots but keeps old reply anchors',async()=>{
  const {c}=context();c.config.feishuTaskTopicRoots.alias='alias-root';c.config.feishuTaskTopicChats.alias='chat';
  c.config.feishuReplyTopicAnchors={'old-root':{threadId:'real',chatId:'chat'}};
  vm.runInContext(source.slice(source.indexOf('async function rotateFeishuTopic('),source.indexOf('async function forgetFeishuThreadMapping(')),c);
  await c.rotateFeishuTopic('alias');assert.equal(c.existingFeishuTaskTopic('real'),'');
  assert.equal(c.feishuReplyThreadId({root_id:'old-root'}),'real');
});
test('takeover is registered before a fast completion, and launch failures finish ownership',async()=>{
  for(const fail of [false,true]){
    const ids=new Set();let calls=0,finished=0;
    const c={canonicalCodexThreadId:v=>v,codexSessionAutoTakeoverThreads:new Set(),isActiveWriterError:()=>true,isCodexDesktopRunning:async()=>true,
      closeCodexDesktop:async()=>{},rememberDesktopTakeover:async id=>ids.add(id),finishDesktopTakeover:async id=>{ids.delete(id);finished++},
      codex:{resumeTask:async()=>{if(!calls++)throw Error('active writer');return{}},continueTask:async()=>{assert(ids.has('real'));if(fail)throw Error('start failed');await c.finishDesktopTakeover('real')}},setTimeout};
    vm.createContext(c);vm.runInContext(source.slice(source.indexOf('async function continueThreadFromFeishu('),source.indexOf('function desktopTakeoverIds(')),c);
    if(fail)await assert.rejects(c.continueThreadFromFeishu('real',[]),/start failed/);else await c.continueThreadFromFeishu('real',[]);
    assert.equal(ids.size,0);assert.equal(finished,1);
  }
});
