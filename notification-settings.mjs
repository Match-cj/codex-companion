export const notificationRules = [
  ['quota_early','额度提前恢复','原计划时间之前从有消耗恢复到 100%','刷新额度时检测；同一恢复不重复'],
  ['quota_reset_soon','额度即将重置','进入勾选的重置前提醒时间','按下方提前量；每个账号、周期、提前量一次'],
  ['quota_exhausted','额度用尽','已用额度达到 100%','检测到时；同账号同额度每天最多一次'],
  ['quota_expiry','重置次数即将到期','可用重置次数的到期时间在 7 天内','每天最多一次'],
  ['plan_expiry','会员即将到期','会员到期时间在 7 天内，或刚到期 48 小时内','每天最多一次；续期后按新到期时间重新计'],
  ['quota_waste','防浪费提醒（5 小时额度）','5 小时额度重置前还剩很多（下方可设提前量和剩余阈值）','每个账号每个周期最多一次；不需要就关掉'],
  ['task_started','主对话开始','识别真实用户主对话，或从网页启动任务','建立话题时；子代理不通知'],
  ['task_completed','主对话完成或中止','主对话本轮有最终结果，或任务已中止','本轮结束时；不发送过程输出'],
  ['task_failed','主对话最终失败','任务失败或自动接管最终失败','最终失败时'],
  ['task_approval','任务等待确认','后台任务请求用户确认或补充输入','收到请求时'],
  ['task_stalled','任务长时间无进展','后台任务持续无新事件','按下方无进展分钟数'],
  ['takeover_start','开始自动接管','检测到符合自动接管条件的失败','开始接管时；需要已开启自动接管'],
  ['task_retry','逐次重试进度','后台正在等待自动重试','每次重试等待时；默认关闭'],
  ['context_pressure','上下文接近上限','主对话已用上下文超过 70% / 85% / 95%','每个对话每档一次；压缩或新对话后重新计'],
  ['service_exit','后台引擎退出','运行任务的 Codex 引擎意外退出','检测到退出时；不保证捕获 Companion 自身退出'],
  ['windows','Windows 应用通知','检测到 Windows 通知中心的新通知','收到时；还受下方应用静音控制'],
  ['retry_unhelpful','「重试」帮不上忙的提醒','桌面端出现自动重试点了也不会好的错误（如会话在另一个应用中打开）','出现时；默认关闭，历史里仍可查'],
].map(([id,name,condition,timing]) => ({ id,name,condition,timing,defaultEnabled:!['task_retry','retry_unhelpful'].includes(id) }));

export function resetReminderLeads(config) {
  return Array.isArray(config.resetReminderLeadMinutes) ? config.resetReminderLeadMinutes : [Number(config.resetReminderMinutes) || 15];
}
export function notificationEnabled(config, id) {
  return config.notificationTypes?.[id] ?? notificationRules.find(rule=>rule.id===id)?.defaultEnabled ?? true;
}
export function notificationType(text, appName, explicit) {
  if (explicit && notificationRules.some(rule=>rule.id===explicit)) return explicit;
  const body=String(text);
  if (body.startsWith('Windows 通知')) return 'windows';
  for (const [pattern,id] of [
    [/^Codex 额度已提前恢复/,'quota_early'],[/^Codex 额度即将重置/,'quota_reset_soon'],[/^Codex 额度已用尽/,'quota_exhausted'],[/^Codex 重置次数将在 7 天内到期/,'quota_expiry'],
    [/^Codex 会员(即将到期|已到期)/,'plan_expiry'],[/^Codex 5 小时额度快重置/,'quota_waste'],[/^这个「重试」不是模型繁忙/,'retry_unhelpful'],
    [/上下文已用约/,'context_pressure'],[/开始自动接管/,'takeover_start'],[/正在自动重试/,'task_retry'],[/^Codex 还在排队，已自动重试/,'task_retry'],[/等待确认\n/,'task_approval'],[/长时间没有进展/,'task_stalled'],[/后台服务已退出/,'service_exit'],
    [/状态：失败|自动接管重试没有成功|因 429 限流中断/,'task_failed'],[/状态：已完成|状态：已中断/,'task_completed'],[/Codex 对话已开始|Codex 任务已启动/,'task_started']
  ]) if(pattern.test(body)) return id;
  return '';
}
export function validateNotificationSettings(data) {
  const result={};
  if(Object.hasOwn(data,'notificationTypes')) {
    if(!data.notificationTypes || typeof data.notificationTypes!=='object' || Array.isArray(data.notificationTypes)) throw Error('通知开关格式不正确。');
    result.notificationTypes={};
    for(const [id,value] of Object.entries(data.notificationTypes)) {
      if(!notificationRules.some(rule=>rule.id===id) || typeof value!=='boolean') throw Error('包含未知通知类型或无效开关。');
      result.notificationTypes[id]=value;
    }
  }
  if(Object.hasOwn(data,'resetReminderLeadMinutes')) {
    const values=data.resetReminderLeadMinutes;
    if(!Array.isArray(values) || values.length>20 || values.some(v=>!Number.isInteger(v)||v<1||v>10080)) throw Error('提前量应为 1～10080 分钟，最多 20 项；可全部取消。');
    result.resetReminderLeadMinutes=[...new Set(values)].sort((a,b)=>b-a);
  }
  if(Object.hasOwn(data,'stallMinutes')) {
    if(!Number.isInteger(data.stallMinutes)||data.stallMinutes<1||data.stallMinutes>1440) throw Error('无进展时间应为 1～1440 分钟。');
    result.stallMinutes=data.stallMinutes;
  }
  if(Object.hasOwn(data,'wasteReminderLeadMinutes')) {
    if(!Number.isInteger(data.wasteReminderLeadMinutes)||data.wasteReminderLeadMinutes<1||data.wasteReminderLeadMinutes>1440) throw Error('防浪费提前量应为 1～1440 分钟。');
    result.wasteReminderLeadMinutes=data.wasteReminderLeadMinutes;
  }
  if(Object.hasOwn(data,'wasteReminderMinPercent')) {
    if(!Number.isInteger(data.wasteReminderMinPercent)||data.wasteReminderMinPercent<1||data.wasteReminderMinPercent>99) throw Error('防浪费剩余阈值应为 1～99 之间的整数百分比。');
    result.wasteReminderMinPercent=data.wasteReminderMinPercent;
  }
  return result;
}
export function nextResetReminder(ledger,key,{resetAt,now,leads,windowMinutes}) {
  if(!Number.isFinite(resetAt)||resetAt<=now) return null;
  const remaining=resetAt-now;
  const due=leads.filter(m=>Number.isInteger(m)&&m>0&&(!windowMinutes||m<=windowMinutes)&&remaining<=m*60).sort((a,b)=>a-b);
  if(!due.length) return null;
  // 官方返回的重置时间偶尔会有一两秒的抖动（21:30:09 ↔ 21:30:10）。
  // 严格相等会把这种抖动当成新周期，导致同一窗口重复提醒；±120 秒内视为同一周期。
  const previousEntry=ledger[key];
  const sameCycle=previousEntry&&Number.isFinite(previousEntry.resetAt)&&Math.abs(previousEntry.resetAt-resetAt)<=120;
  const previous=sameCycle?previousEntry.sentMinutes||[]:[];
  const nearest=due[0];
  ledger[key]={resetAt,sentMinutes:[...new Set([...previous,...due])]};
  return previous.includes(nearest) ? null : nearest;
}

// 会员到期时间可能是 ISO 字符串，也可能是秒/毫秒时间戳，统一换算成秒。
export function parseExpirySeconds(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{10,13}$/.test(trimmed)) { const num = Number(trimmed); return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num); }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : NaN;
  }
  return NaN;
}

// 付费计划 + 到期时间已过 = 本地令牌还是旧的，不代表真过期（续费后要等令牌刷新才更新）。
// 实测案例：账号续费后 plan_type=plus 且能正常用，但 subscription_expires_at 还停在昨天。
const PAID_PLANS = new Set(['plus', 'pro', 'team', 'enterprise']);
export function planExpiryStale(account) {
  const plan = String(account?.plan_type || '').toLowerCase();
  const expiry = parseExpirySeconds(account?.subscription_expires_at);
  return PAID_PLANS.has(plan) && Number.isFinite(expiry) && expiry <= Date.now() / 1000;
}

// 一句话说明会员到期情况：空字符串 = 不用提。
export function planExpirySuffix(account) {
  const expiry = parseExpirySeconds(account?.subscription_expires_at);
  if (!Number.isFinite(expiry) || planExpiryStale(account)) return '';
  if (expiry <= Date.now() / 1000) return '会员已到期';
  const days = (expiry - Date.now() / 1000) / 86400;
  const date = new Date(expiry * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return days <= 7 ? `会员 ${date} 到期` : '';
}

// 防浪费提醒：5 小时额度快重置了但还剩很多，提醒一次别浪费。
// 每个账号、每个重置周期最多一次；官方重置时间偶有一两秒抖动，±120 秒内视为同一周期。
export function nextWasteReminder(ledger,key,{resetAt,now,leadMinutes,remainingPercent,minPercent,windowMinutes}) {
  const lead=Number(leadMinutes)>0?Number(leadMinutes):30;
  const min=Number(minPercent)>0?Number(minPercent):30;
  if(!Number.isFinite(resetAt)||resetAt<=now) return false;
  // 只看小时级窗口（5 小时额度），周额度重置前剩得多是正常事，不提醒。
  if(Number.isFinite(windowMinutes)&&windowMinutes>1440) return false;
  if(!Number.isFinite(remainingPercent)||remainingPercent<min) return false;
  if(resetAt-now>lead*60) return false;
  const previousEntry=ledger[key];
  const sameCycle=previousEntry&&Number.isFinite(previousEntry.resetAt)&&Math.abs(previousEntry.resetAt-resetAt)<=120;
  if(sameCycle&&previousEntry.notified) return false;
  ledger[key]={resetAt,notified:true};
  return true;
}
