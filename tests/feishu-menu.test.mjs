import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('Feishu phone menu can toggle desktop auto takeover and show status', () => {
  assert.match(server, /handleFeishuControlCommand/);
  assert.match(server, /自动接管已开启/);
  assert.match(server, /自动接管已关闭/);
  assert.match(server, /运行中对话：\$\{feishuRunningCount\(\)\}/);
  assert.match(server, /绑定最近对话/);
});

test('not-found reply keeps original mapping and does not claim confirmed deletion', () => {
  assert.match(server, /thread\\s\+not\\s\+found/);
  const handler=server.slice(server.indexOf("    console.error('[feishu reply]'"),server.indexOf('function isActiveWriterError('));
  assert.doesNotMatch(handler,/forgetFeishuThreadMapping\(/);
  assert.match(handler,/尚不能确认对话已删除/);
});

test('new engine resumes cached task before continuing instead of assuming server registration', async () => {
  const tasks=new Map([['thread-A',{id:'thread-A',status:'completed',prompt:'stale'}]]);let resumes=0;
  const c={tasks,Date,process,trim:text=>text};vm.createContext(c);
  const start=server.indexOf('  async resumeTask(threadId)');
  vm.runInContext('this.Engine=class {'+server.slice(start,server.indexOf('  async continueTask(',start))+'}',c);
  const engine=new c.Engine();engine.turns=new Map();
  engine.request=async(method)=>{assert.equal(method,'thread/resume');resumes++;return{thread:{id:'thread-A',name:'current',turns:[]}}};
  const result=await engine.resumeTask('thread-A');
  assert.equal(result.prompt,'current');assert.equal(resumes,1);
  await engine.resumeTask('thread-A');assert.equal(resumes,1);
});
