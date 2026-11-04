export const notificationRules = [
  ['quota_early','额度提前恢复','原计划时间之前从有消耗恢复到 100%','刷新额度时检测；同一恢复不重复'],
  ['quota_reset_soon','额度即将重置','进入勾选的重置前提醒时间','按下方提前量；每个账号、周期、提前量一次'],
  ['quota_exhausted','额度用尽','已用额度达到 100%','检测到时；同账号同额度每天最多一次'],
  ['quota_expiry','重置次数即将到期','可用重置次数的到期时间在 7 天内','每天最多一次'],
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
].map(([id,name,condition,timing]) => ({ id,name,condition,timing,defaultEnabled:id !== 'task_retry' }));

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
  return result;
}
export function nextResetReminder(ledger,key,{resetAt,now,leads,windowMinutes}) {
  if(!Number.isFinite(resetAt)||resetAt<=now) return null;
  const remaining=resetAt-now;
  const due=leads.filter(m=>Number.isInteger(m)&&m>0&&(!windowMinutes||m<=windowMinutes)&&remaining<=m*60).sort((a,b)=>a-b);
  if(!due.length) return null;
  const previous=ledger[key]?.resetAt===resetAt ? ledger[key].sentMinutes||[] : [];
  const nearest=due[0];
  ledger[key]={resetAt,sentMinutes:[...new Set([...previous,...due])]};
  return previous.includes(nearest) ? null : nearest;
}
