import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { notificationEnabled, notificationRules, notificationType, resetReminderLeads, validateNotificationSettings, nextResetReminder, nextWasteReminder } from '../notification-settings.mjs';

test('catalog exists before any notification, defaults preserve quiet retries, validation rejects unknown settings', () => {
  assert(notificationRules.some(rule=>rule.id==='quota_early'));
  assert.equal(notificationEnabled({},'quota_early'),true);
  assert.equal(notificationEnabled({},'task_retry'),false);
  assert.equal(notificationEnabled({},'retry_unhelpful'),false);
  assert.equal(notificationEnabled({},'plan_expiry'),true);
  assert.equal(notificationEnabled({},'quota_waste'),true);
  assert.equal(notificationEnabled({notificationTypes:{task_retry:true}},'task_retry'),true);
  assert.deepEqual(resetReminderLeads({resetReminderMinutes:45}),[45]);
  assert.deepEqual(validateNotificationSettings({resetReminderLeadMinutes:[60,1440,60]}).resetReminderLeadMinutes,[1440,60]);
  assert.deepEqual(validateNotificationSettings({resetReminderLeadMinutes:[]}).resetReminderLeadMinutes,[]);
  assert.equal(validateNotificationSettings({wasteReminderLeadMinutes:45}).wasteReminderLeadMinutes,45);
  assert.equal(validateNotificationSettings({wasteReminderMinPercent:50}).wasteReminderMinPercent,50);
  for(const input of [{notificationTypes:{unknown:true}},{notificationTypes:{quota_early:'yes'}},{resetReminderLeadMinutes:[0]},{resetReminderLeadMinutes:[Infinity]},{stallMinutes:0},{wasteReminderLeadMinutes:0},{wasteReminderMinPercent:100}]) assert.throws(()=>validateNotificationSettings(input));
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
test('one-second reset-time jitter is the same cycle, not a re-armed reminder', () => {
  // 复现 2026-11-05 21:24 连发两条的根因：官方把重置时间从 :09 改成 :10，严格相等导致重复发送。
  const ledger={};const key='A:5小时额度';const leads=[15];
  const base=2000000000;
  assert.equal(nextResetReminder(ledger,key,{resetAt:base,now:base-720,leads,windowMinutes:300}),15);
  assert.equal(nextResetReminder(ledger,key,{resetAt:base+1,now:base-360,leads,windowMinutes:300}),null);
  assert.equal(nextResetReminder(ledger,key,{resetAt:base-1,now:base-300,leads,windowMinutes:300}),null);
  assert.equal(ledger[key].resetAt,base-1);
  // 真正的新周期（5 小时后）仍然会重新提醒。
  assert.equal(nextResetReminder(ledger,key,{resetAt:base+18000,now:base+18000-720,leads,windowMinutes:300}),15);
});
test('waste reminder fires once per cycle only inside lead window and only for hourly windows', () => {
  const resetAt=2000000000,key='A:5小时额度';let ledger={};
  const at=(remaining,remainingPercent,reset=resetAt)=>nextWasteReminder(ledger,key,{resetAt:reset,now:reset-remaining,leadMinutes:30,remainingPercent,minPercent:30,windowMinutes:300});
  assert.equal(at(3600,80),false);          // 还没进入提前量
  assert.equal(at(1800,20),false);          // 剩余太少，不值得提醒
  assert.equal(at(1800,80),true);           // 进入提前量且剩很多 → 提醒
  assert.equal(at(600,80),false);           // 同一周期不再提醒
  ledger=JSON.parse(JSON.stringify(ledger)); // 落盘后重启也不重发
  assert.equal(at(300,80),false);
  assert.equal(at(1800,80,resetAt+18000),true); // 下一个周期重新提醒
  assert.equal(nextWasteReminder({},'B',{resetAt:2000000000,now:2000000000-600,leadMinutes:30,remainingPercent:80,minPercent:30,windowMinutes:10080}),false); // 周额度不提醒
  // 官方重置时间一两秒抖动视为同一周期，不会重复提醒。
  const jitter={};
  assert.equal(nextWasteReminder(jitter,'C',{resetAt:2000000000,now:2000000000-600,leadMinutes:30,remainingPercent:80,minPercent:30,windowMinutes:300}),true);
  assert.equal(nextWasteReminder(jitter,'C',{resetAt:2000000001,now:2000000000-300,leadMinutes:30,remainingPercent:80,minPercent:30,windowMinutes:300}),false);
});
test('plan expiry and unhelpful retry notifications classify into their own types', () => {
  assert.equal(notificationType('Codex 会员已到期\n账号：X','Codex 额度'),'plan_expiry');
  assert.equal(notificationType('Codex 会员即将到期\n账号：X','Codex 额度'),'plan_expiry');
  assert.equal(notificationType('Codex 5 小时额度快重置了，还剩不少\n账号：X','Codex 额度','quota_waste'),'quota_waste');
  assert.equal(notificationType('这个「重试」不是模型繁忙，我没有自动点\n窗口：W','Codex 任务'),'retry_unhelpful');
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
