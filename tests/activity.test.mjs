import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
function context(){const c={Date,tasks:new Map()};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('const sessionActivities ='),source.indexOf('async function seedSessionActivity(')),c);return c}
const event=(type,turn='a')=>({type:'event_msg',timestamp:new Date().toISOString(),payload:{type,turn_id:turn}});
test('two independent main threads; child agents and unknown sources excluded',()=>{const c=context();for(const id of ['one','two'])c.observeSessionActivity(event('task_started'),'user',id);c.observeSessionActivity(event('task_started'),'subagent','child');c.observeSessionActivity(event('task_started'),'unknown','unknown');assert.equal(c.publicTaskActivity().length,2);c.observeSessionActivity(event('task_complete'),'user','one');assert.equal(c.publicTaskActivity().length,1)});
test('old completion does not finish a newer turn, abort clears record',()=>{const c=context();c.observeSessionActivity(event('task_started','new'),'user','one');c.observeSessionActivity(event('task_complete','old'),'user','one');assert.equal(c.publicTaskActivity().length,1);c.observeSessionActivity(event('turn_aborted','new'),'user','one');assert.equal(c.publicTaskActivity().length,0)});
test('backend takeover overrides matching desktop record without double counting',()=>{const c=context();c.observeSessionActivity(event('task_started'),'user','one');c.tasks.set('one',{id:'one',status:'waiting_confirmation',remoteDesktopTakeover:true,prompt:'Task',lastEventAt:Date.now()+1});const rows=c.publicTaskActivity();assert.equal(rows.length,1);assert.equal(rows[0].source,'takeover');assert.equal(rows[0].status,'waiting_confirmation');c.tasks.get('one').status='completed';assert.equal(c.publicTaskActivity().length,0)});
test('new desktop turn is not hidden by an older completed backend task',()=>{const c=context();c.tasks.set('one',{id:'one',status:'completed',lastEventAt:1});c.observeSessionActivity(event('task_started'),'user','one');assert.equal(c.publicTaskActivity().length,1)});
test('dashboard separates default target from counts and escapes task titles',()=>{
  const html=fs.readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
  const line=html.split('\n').find(line=>line.includes('function renderTaskActivity(status)'));
  const elements={};const c={Date,statusText:{running:'执行中'},$:id=>elements[id]||(elements[id]={}),esc:v=>String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};vm.createContext(c);vm.runInContext(line,c);
  c.renderTaskActivity({feishu:{boundThreadName:'Default A',boundThreadId:'one'},taskActivity:{monitorReady:true,rows:[{id:'one',title:'<unsafe>',status:'recorded_running',source:'desktop'},{id:'two',title:'Task B',status:'running',source:'takeover'}]}});
  assert(elements.defaultReply.textContent.includes('Default A'));assert(elements.activitySummary.textContent.includes('后台活动 1'));assert(elements.activitySummary.textContent.includes('桌面运行记录 1'));assert(elements.taskActivity.innerHTML.includes('&lt;unsafe&gt;'));assert(!elements.taskActivity.innerHTML.includes('<unsafe>'));
});
