import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { notificationEnabled, notificationRules, notificationType, resetReminderLeads, validateNotificationSettings, nextResetReminder } from '../notification-settings.mjs';

test('catalog exists before any notification, defaults preserve quiet retries, validation rejects unknown settings', () => {
  assert(notificationRules.some(rule=>rule.id==='quota_early'));
  assert.equal(notificationEnabled({},'quota_early'),true);
  assert.equal(notificationEnabled({},'task_retry'),false);
  assert.equal(notificationEnabled({notificationTypes:{task_retry:true}},'task_retry'),true);
  assert.deepEqual(resetReminderLeads({resetReminderMinutes:45}),[45]);
  assert.deepEqual(validateNotificationSettings({resetReminderLeadMinutes:[60,1440,60]}).resetReminderLeadMinutes,[1440,60]);
  assert.deepEqual(validateNotificationSettings({resetReminderLeadMinutes:[]}).resetReminderLeadMinutes,[]);
  for(const input of [{notificationTypes:{unknown:true}},{notificationTypes:{quota_early:'yes'}},{resetReminderLeadMinutes:[0]},{resetReminderLeadMinutes:[Infinity]},{stallMinutes:0}]) assert.throws(()=>validateNotificationSettings(input));
});
test('multiple reset thresholds fire once each, survive restart, and rearm only next cycle', () => {
  const resetAt=2000000000,key='A:week',leads=[1440,360,60,15];let ledger={};
  const at=remaining=>nextResetReminder(ledger,key,{resetAt,now:resetAt-remaining,leads,windowMinutes:10080});
  assert.equal(at(86401),null);
  assert.equal(at(86399),1440);
  ledger=JSON.parse(JSON.stringify(ledger));
  assert.equal(at(86000),null);
  assert.equal(at(21599),360);
  assert.equal(at(3599),60);
  assert.equal(at(899),15);
  assert.equal(at(800),null);
  assert.equal(at(0),null);
  assert.equal(nextResetReminder(ledger,key,{resetAt:resetAt+604800,now:resetAt+604800-85000,leads,windowMinutes:10080}),1440);
});
test('late first sample sends nearest threshold only, short windows ignore day reminders, empty leads disable', () => {
  const ledger={};const options={resetAt:2000000000,now:2000000000-600,leads:[1440,360,60,15],windowMinutes:10080};
  assert.equal(nextResetReminder(ledger,'A',options),15);
  assert.equal(nextResetReminder(ledger,'A',options),null);
  assert.equal(nextResetReminder({},'A',{...options,now:options.resetAt-4*3600,leads:[1440],windowMinutes:300}),null);
  assert.equal(nextResetReminder({},'A',{...options,leads:[]}),null);
});
test('disabled event type never reaches Feishu transport, explicit type avoids matching quoted task content', async () => {
  const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
  const history=[];let saved=0;
  const c={config:{notificationTypes:{quota_early:false}},notificationType,notificationEnabled,normalizeAppName:v=>v,trim:v=>v,pushHistory:v=>history.push(v),saveConfig:async()=>{saved++}};
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('async function notify(text,'),source.indexOf('function quotaLabel(')),c);
  const result=await c.notify('Codex 额度已提前恢复至 100%',{appName:'Codex 额度'});
  assert.equal(result.reason,'type-disabled');assert.equal(history.length,1);assert(saved>0);
  assert.equal(notificationType('最终结果里提到额度即将重置','Codex 任务','task_completed'),'task_completed');
});
test('remote request cannot launch Windows uninstall page; local route only opens apps settings', async () => {
  const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
  let launches=0,response;
  const c={req:{method:'POST',socket:{remoteAddress:'remote'}},u:{pathname:'/api/system/uninstall-page'},res:{},process:{platform:'win32'},isLoopback:()=>false,spawn:()=>{launches++},send:(_res,status,value)=>{response={status,value}}};
  vm.createContext(c);
  const start=source.indexOf("    if(req.method==='POST'&&u.pathname==='/api/system/uninstall-page')");
  vm.runInContext('this.route=async()=>{'+source.slice(start,source.indexOf("    if (req.method==='POST'&&u.pathname==='/api/config')",start))+'}',c);
  await c.route();assert.equal(response.status,403);assert.equal(launches,0);
  assert.match(source,/spawn\('explorer\.exe',\['ms-settings:appsfeatures'\]/);
  assert.doesNotMatch(source.slice(start,source.indexOf("    if (req.method==='POST'&&u.pathname==='/api/config')",start)),/Uninstall Companion\.ps1|Remove-Item|rm\(/);
});
