// Recover only explicit thread anchors from this configured bot in its bound
// chat. Never guess from a title, a user's text, or the latest/default thread.
export async function recoverReplyTarget({ message, chatId, appId, canonical, fetchMessage, maxReads = 4 }) {
  const root=String(message.root_id||message.rootId||'');
  const parent=String(message.parent_id||message.parentId||'');
  const queue=[root,parent].filter(Boolean),seen=new Set();
  for(let reads=0;queue.length&&reads<maxReads;){
    const id=queue.shift();if(seen.has(id))continue;seen.add(id);reads++;
    let response;
    try{response=await fetchMessage(id)}catch{return {threadId:'',reason:'message-read-failed'}}
    if(response?.code)return {threadId:'',reason:'message-read-rejected'};
    const item=response?.data?.items?.find(item=>item.message_id===id);
    if(!item||item.chat_id!==chatId)return {threadId:'',reason:'chat-mismatch'};
    if(item.sender?.sender_type==='app'&&item.sender.id===appId){
      const body=String(item.body?.content||'');
      const ids=[...new Set([...body.matchAll(/任务：[ \t]*([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/gi)].map(match=>match[1]))];
      if(/Codex (?:对话已开始|任务已启动)/.test(body)&&ids.length===1){
        const threadId=canonical(ids[0]);
        if(threadId)return {threadId,rootId:root||id,reason:'bot-root-anchor'};
      }
    }
    // Relations are server-provided metadata, not instructions from the body.
    for(const next of [item.root_id,item.parent_id])if(next&&!seen.has(next))queue.push(next);
  }
  return {threadId:'',reason:'no-explicit-anchor'};
}
