import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function sessionAppendStartOffset(');
const end = source.indexOf('function sessionKindFromMeta(');
const context = {};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)};this.sessionAppendStartOffset=sessionAppendStartOffset;`, context);

test('session monitor quarantines multi-callback rewrites', () => {
  assert.match(source, /codexSessionRewrites\.set\(file/);
  assert.match(source, /historical[\r\n]+\s*\/\/ bytes as fresh conversation events/);
});

test('opening an old project after monitoring starts does not replay its history', () => {
  assert.equal(context.sessionAppendStartOffset(5000, { size: 1200, birthtimeMs: 1 }, Date.now()), 1200);
  assert.equal(context.sessionAppendStartOffset(5000, { size: 5000, birthtimeMs: 1 }, Date.now()), 5000);
});

test('a newly created session file is read from the beginning once', () => {
  const now = Date.now();
  assert.equal(context.sessionAppendStartOffset(null, { size: 1200, birthtimeMs: now - 1000 }, now), 0);
  assert.equal(context.sessionAppendStartOffset(null, { size: 1200, birthtimeMs: now - 10 * 60 * 1000 }, now), 1200);
});

test('historical JSONL events are rejected by their event timestamp', () => {
  assert.match(source, /function isFreshCodexSessionEvent\(/);
  const helperStart = source.indexOf('function isFreshCodexSessionEvent(');
  const helperEnd = source.indexOf('function observeSessionPrompt(', helperStart);
  const helperContext = {};
  vm.createContext(helperContext);
  vm.runInContext(`${source.slice(helperStart, helperEnd)};this.isFreshCodexSessionEvent=isFreshCodexSessionEvent;`, helperContext);
  const cutoff = Date.parse('2026-10-19T10:00:00.000Z');
  assert.equal(helperContext.isFreshCodexSessionEvent({ timestamp: '2026-10-19T09:59:00.000Z' }, cutoff), false);
  assert.equal(helperContext.isFreshCodexSessionEvent({ timestamp: '2026-10-19T10:00:01.000Z' }, cutoff), true);
});

function monitorContext() {
  const c = { path, fs: fsp, Buffer, Date, console, config: {}, notices: [], topics: [], titles: new Map(), sessionActivities: new Map(),
    codexSessionIdentities: new Map(), codexSessionKinds: new Map(), codexSessionOffsets: new Map(), codexSessionRewrites: new Map(), codexSessionPartials: new Map(), codexSessionContextStats: new Map(), codexSessionImagePaths: new Map(), codexSessionHtmlPaths: new Map(), codexSessionMonitorStartedAt: Date.now(),
    observeSessionActivity() {}, desktopTakeoverIds: () => [], finishDesktopTakeover: async () => {},
    announceDesktopConversation: async id => c.topics.push(id), completionNotice: async value => value,
    notifyTurnResult: async (notice, result) => c.notices.push({ notice, result }) };
  vm.createContext(c);
  for (const [from, to] of [
    ['function sessionThreadId(', '// Codex may rewrite'],
    ['function sessionKindFromMeta(', 'function projectLabel('],
    ['async function readCodexSessionKind(', 'async function markCodexTurnComplete('],
    ['async function processCodexSessionAppend(', 'async function startCodexSessionMonitor('],
    ['function sessionAppendStartOffset(', 'function sessionKindFromMeta('],
  ]) vm.runInContext(source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from))), c);
  return c;
}

test('title extraction rejects developer instructions and injected context, accepts real user requests', () => {
  const c = monitorContext();
  for (const text of ['<skills_instructions>internal</skills_instructions>', 'The following tools are no longer available.', '<environment_context>cwd</environment_context>']) {
    assert.equal(c.conversationTitle(text), '');
  }
  c.observeSessionPrompt({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Internal instructions' }] } }, 'main');
  assert.equal(c.sessionActivities.size, 0);
  c.observeSessionPrompt({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Files mentioned by the user:\nattachment\n## My request:\n修复画布布局\n<image>' }] } }, 'main');
  assert.equal(c.sessionActivities.get('main').title, '修复画布布局');
});

test('real session append ignores child completion and commentary, uses metadata identity for main completion', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'companion-notify-test-'));
  try {
    const mainId = '11111111-1111-4111-8111-111111111111';
    const childId = '22222222-2222-4222-8222-222222222222';
    const c = monitorContext();
    const run = async (id, kind, events) => {
      const file = path.join(dir, `rollout-${id}.jsonl`);
      const rows = [{ type: 'session_meta', payload: { id: kind === 'user' ? mainId : childId, thread_source: kind, source: kind === 'subagent' ? { subagent: { thread_spawn: { parent_thread_id: mainId } } } : 'vscode' } }, ...events];
      await fsp.writeFile(file, rows.map(e => JSON.stringify({ timestamp: new Date().toISOString(), ...e })).join('\n') + '\n');
      c.codexSessionOffsets.set(file, 0);
      await c.processCodexSessionAppend(file);
      return file;
    };
    const prompt = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修复画布布局' }] } };
    const completion = { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '完成结果' } };
    await run(childId, 'subagent', [prompt, completion]);
    assert.equal(c.notices.length, 0);
    assert.equal(c.topics.length, 0);
    await run('33333333-3333-4333-8333-333333333333', 'user', [{ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>internal' }] } }, { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '检查中' }] } }]);
    assert.equal(c.notices.length, 0);
    assert.equal(c.topics.length, 0);
    const file = await run('44444444-4444-4444-8444-444444444444', 'user', [prompt, completion]);
    assert.equal(c.sessionThreadId(file), mainId);
    assert.deepEqual(c.topics, [mainId]);
    assert.equal(c.notices.length, 1);
    assert.equal(c.notices[0].result.taskId, mainId);
    assert.equal(c.notices[0].result.finalText, '完成结果');
    await c.processCodexSessionAppend(file);
    assert.equal(c.notices.length, 1);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('metadata alias reuses existing topic without replacing a canonical topic or importing a child topic', () => {
  const c = monitorContext();
  const id = '11111111-1111-4111-8111-111111111111';
  const alias = '33333333-3333-4333-8333-333333333333';
  c.config = { feishuBoundChatId: 'chat', feishuTaskTopicRoots: { [alias]: 'existing-root' }, feishuTaskTopicChats: { [alias]: 'chat' }, feishuMessageThreads: { reply: alias } };
  c.rememberSessionIdentity(`rollout-${alias}.jsonl`, { id, thread_source: 'user' });
  assert.equal(c.config.feishuTaskTopicRoots[id], 'existing-root');
  assert.equal(c.config.feishuMessageThreads.reply, id);
  c.config.feishuTaskTopicRoots[id] = 'canonical-root';
  c.rememberSessionIdentity(`rollout-${alias}.jsonl`, { id, thread_source: 'user' });
  assert.equal(c.config.feishuTaskTopicRoots[id], 'canonical-root');
  delete c.config.feishuTaskTopicRoots[id];
  c.rememberSessionIdentity(`rollout-${alias}.jsonl`, { id, thread_source: 'subagent' });
  assert.equal(c.config.feishuTaskTopicRoots[id], undefined);
});

test('metadata larger than 16 KB recovers real thread identity on startup and routes old replies', async () => {
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'companion-long-meta-'));
  try {
    const alias='33333333-3333-4333-8333-333333333333',id='11111111-1111-4111-8111-111111111111';
    const file=path.join(dir,`rollout-${alias}.jsonl`);
    const meta=JSON.stringify({type:'session_meta',payload:{id,thread_source:'user',instructions:'中文说明'.repeat(6000)}});
    assert(Buffer.byteLength(meta)>16384);
    await fsp.writeFile(file,meta+'\n'+JSON.stringify({type:'event_msg',payload:{type:'task_complete'}})+'\n');
    const c=monitorContext();
    assert.equal(await c.readCodexSessionKind(file),'user');
    assert.equal(c.sessionThreadId(file),id);
    assert.equal(c.canonicalCodexThreadId(alias),id);
    assert.equal(c.canonicalCodexThreadId(''),'');
    c.config={feishuBoundThreadId:'unrelated',notificationHistory:[{sent:true,messageId:'recent-notice',taskId:alias}]};
    vm.runInContext(source.slice(source.indexOf('function feishuReplyThreadId('),source.indexOf('async function continueThreadFromFeishu(')),c);
    assert.equal(c.feishuReplyThreadId({parent_id:'recent-notice'}),id);
    assert.equal(c.feishuReplyThreadId({root_id:'unknown-topic'}),'');
    assert.equal(c.feishuReplyThreadId({}),'unrelated');
    assert.equal(c.notices.length,0,'metadata scanning must not replay historical completion');
  }finally{await fsp.rm(dir,{recursive:true,force:true})}
});
