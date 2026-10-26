import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoverReplyTarget} from '../feishu-reply-recovery.mjs';
const alias='33333333-3333-4333-8333-333333333333',canonical='11111111-1111-4111-8111-111111111111';
const item=(id,extra={})=>({message_id:id,chat_id:'bound-chat',sender:{sender_type:'app',id:'our-app'},body:{content:JSON.stringify({title:'项目｜对话',content:[[{text:`Codex 对话已开始\n任务：${alias}`}]]})},...extra});
const options=(messages)=>({message:{root_id:'old-root',parent_id:'error-reply'},chatId:'bound-chat',appId:'our-app',canonical:id=>id===alias?canonical:id,fetchMessage:async id=>({code:0,data:{items:messages[id]?[messages[id]]:[]}})});
test('deleted local mapping recovers from existing bot topic root without group-history permission',async()=>{
  let reads=0;const settings=options({'old-root':item('old-root')});
  const fetch=settings.fetchMessage;settings.fetchMessage=async id=>{reads++;return fetch(id)};
  const result=await recoverReplyTarget(settings);
  assert.equal(result.threadId,canonical);assert.equal(result.rootId,'old-root');assert.equal(reads,1);
});
test('replying to an unlinked error receipt follows server-provided parent/root only',async()=>{
  const settings=options({'error-reply':item('error-reply',{body:{content:'无法继续'},root_id:'actual-root'}),'actual-root':item('actual-root')});
  settings.message={parent_id:'error-reply'};
  const result=await recoverReplyTarget(settings);assert.equal(result.threadId,canonical);
});
test('wrong chat, another bot, user-authored marker, and ambiguous task IDs cannot redirect',async()=>{
  for(const override of [
    {chat_id:'another-chat'},
    {sender:{sender_type:'app',id:'another-app'}},
    {sender:{sender_type:'user',id:'owner'}},
    {body:{content:`Codex 对话已开始 任务：${alias} 任务：${canonical}`}},
    {body:{content:`普通结果引用 任务：${alias}`}},
  ])assert.equal((await recoverReplyTarget(options({'old-root':item('old-root',override)}))).threadId,'');
});
test('permission failure and cyclic ancestry fail closed with bounded reads',async()=>{
  const settings=options({});settings.fetchMessage=async()=>{throw Error('HTTP failure with private request object')};
  assert.deepEqual(await recoverReplyTarget(settings),{threadId:'',reason:'message-read-failed'});
  let reads=0;settings.fetchMessage=async id=>{reads++;return{data:{items:[item(id,{body:{content:'no anchor'},root_id:id,parent_id:'error-reply'})]}}};
  assert.equal((await recoverReplyTarget(settings)).threadId,'');assert(reads<=4);
});
