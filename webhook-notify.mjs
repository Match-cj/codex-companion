// Generic outbound notification layer.
//
// Feishu keeps its own rich implementation (app bot + topic threads + replies),
// because it is the only two-way channel. Everything else is one-way: we take a
// webhook URL, wrap the text in the shape that channel expects, and POST it.
//
// Adding a channel means adding one entry to KINDS and (optionally) one case in
// buildWebhookRequest. No server.mjs surgery required.

export const KINDS = [
  { id: 'wecom', label: '企业微信群机器人', hint: '群设置 → 群机器人 → 添加 → 复制 Webhook 地址', needsToken: false, maxBytes: 1800 },
  { id: 'dingtalk', label: '钉钉群机器人', hint: '群设置 → 智能群助手 → 添加机器人 → 自定义 → 复制 Webhook 地址', needsToken: false, maxBytes: 1800 },
  { id: 'pushplus', label: 'PushPlus（微信）', hint: 'https://www.pushplus.plus 登录后复制 token，免费 200 条/天', needsToken: true, maxBytes: 4000 },
  { id: 'serverchan', label: 'Server酱（微信）', hint: 'https://sct.ftqq.com 登录后复制 SendKey，免费 5 条/天', needsToken: true, maxBytes: 4000 },
  { id: 'bark', label: 'Bark（iPhone）', hint: 'Bark App 首页的推送地址，形如 https://api.day.app/你的key', needsToken: false, maxBytes: 3000 },
  { id: 'telegram', label: 'Telegram', hint: '地址填 https://api.telegram.org/bot<token>/sendMessage，token 填 chat_id', needsToken: true, maxBytes: 4000 },
  { id: 'discord', label: 'Discord', hint: '频道设置 → 整合 → Webhook → 复制 Webhook URL', needsToken: false, maxBytes: 1800 },
  { id: 'custom', label: '自定义（POST JSON）', hint: '向你的地址 POST {"text":"...","title":"..."}', needsToken: false, maxBytes: 20000 },
];

const KIND_IDS = new Set(KINDS.map(kind => kind.id));
export const kindLabel = id => KINDS.find(kind => kind.id === id)?.label || String(id || '');

export function trimBytes(text, limit) {
  const value = String(text ?? '');
  if (!limit || Buffer.byteLength(value, 'utf8') <= limit) return value;
  let used = 0;
  let out = '';
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > limit - 4) break;
    used += size;
    out += char;
  }
  return `${out}\n…`;
}

export function isAllowedWebhookUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol === 'https:') return true;
  // Plain HTTP is only tolerated for a webhook running on this machine.
  const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  return parsed.protocol === 'http:' && local;
}

function targetUrl(target) {
  const explicit = String(target.url || '').trim();
  if (explicit) return explicit;
  const token = String(target.token || '').trim();
  if (!token) return '';
  if (target.kind === 'pushplus') return 'https://www.pushplus.plus/send';
  if (target.kind === 'serverchan') return `https://sctapi.ftqq.com/${encodeURIComponent(token)}.send`;
  if (target.kind === 'bark') return `https://api.day.app/${encodeURIComponent(token)}`;
  return '';
}

// Returns the cleaned target or throws with a message a non-programmer can act on.
export function normalizeWebhookTarget(input = {}, index = 0) {
  const kind = String(input.kind || '').trim();
  if (!KIND_IDS.has(kind)) throw new Error(`第 ${index + 1} 个通知渠道的类型不认识：${kind || '（空）'}`);
  const spec = KINDS.find(item => item.id === kind);
  const name = String(input.name || '').trim().slice(0, 40) || spec.label;
  const token = String(input.token || '').trim();
  const url = targetUrl({ ...input, kind });
  if (!url) throw new Error(`「${name}」缺少地址${spec.needsToken ? '或 token' : ''}`);
  if (!isAllowedWebhookUrl(url)) throw new Error(`「${name}」的地址必须是以 https:// 开头的完整地址`);
  if (spec.needsToken && kind !== 'bark' && !token) throw new Error(`「${name}」缺少 token（${spec.hint}）`);
  return {
    id: String(input.id || '').trim() || `${kind}-${index + 1}`,
    kind,
    name,
    url,
    token,
    enabled: input.enabled !== false,
  };
}

export function validateWebhooks(list) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new Error('通知渠道格式不对');
  if (list.length > 10) throw new Error('最多只能配置 10 个通知渠道');
  const seen = new Set();
  return list.map((item, index) => {
    const target = normalizeWebhookTarget(item, index);
    // The URL is the identity: two entries with the same URL would duplicate
    // every message.
    const key = `${target.kind}|${target.url}|${target.token}`;
    if (seen.has(key)) throw new Error(`「${target.name}」和前面的渠道重复了`);
    seen.add(key);
    return target;
  });
}

export function activeWebhookTargets(config = {}) {
  return (Array.isArray(config.webhooks) ? config.webhooks : []).filter(target => target && target.enabled !== false && target.url);
}

export function buildWebhookRequest(target, text, opts = {}) {
  const kind = String(target.kind || '');
  const spec = KINDS.find(item => item.id === kind);
  const body = trimBytes(text, spec?.maxBytes);
  const title = String(opts.title || opts.appName || 'Codex Companion').slice(0, 60);
  const url = targetUrl(target);
  const headers = { 'Content-Type': 'application/json' };
  switch (kind) {
    case 'wecom':
      return { url, headers, body: { msgtype: 'text', text: { content: body } } };
    case 'dingtalk':
      return { url, headers, body: { msgtype: 'text', text: { content: body } } };
    case 'pushplus':
      return { url, headers, body: { token: String(target.token || ''), title, content: body, template: 'txt' } };
    case 'serverchan':
      return { url, headers, body: { title, desp: body } };
    case 'bark':
      return { url, headers, body: { title, body, group: 'Codex Companion' } };
    case 'telegram':
      return { url, headers, body: { chat_id: String(target.token || ''), text: body, disable_web_page_preview: true } };
    case 'discord':
      return { url, headers, body: { content: body } };
    default:
      return { url, headers, body: { title, text: body, app: 'Codex Companion', at: new Date().toISOString() } };
  }
}

// Chinese channels answer HTTP 200 with an error code in the body, so the status
// code alone is not proof of delivery.
export function webhookBodyRejected(kind, payload) {
  if (!payload || typeof payload !== 'object') return '';
  const code = payload.errcode ?? payload.code ?? payload.status;
  if (code === undefined || code === null) return '';
  const numeric = Number(code);
  if (!Number.isFinite(numeric) || numeric === 0 || numeric === 200) return '';
  return String(payload.errmsg || payload.message || payload.msg || `错误码 ${numeric}`);
}

// Technical transport errors mean nothing to a non-programmer; show the cause.
export function friendlyWebhookReason(reason) {
  const text = String(reason || '').trim() || '发送失败';
  if (/(fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up)/i.test(text)) return '网络连不上这个地址，请检查 URL、端口和网络';
  if (/TimeoutError|timed? ?out|aborted/i.test(text)) return '请求超时，对方没有回应';
  return text;
}

export async function sendWebhook(target, text, opts = {}) {
  let request;
  try {
    request = buildWebhookRequest(target, text, opts);
  } catch (error) {
    return { ok: false, id: target.id, kind: target.kind, name: target.name, reason: error.message };
  }
  if (!request.url) {
    return { ok: false, id: target.id, kind: target.kind, name: target.name, reason: '缺少推送地址' };
  }
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: opts.signal,
    });
    const payload = await response.json().catch(() => null);
    const rejected = webhookBodyRejected(target.kind, payload);
    if (!response.ok || rejected) {
      return { ok: false, id: target.id, kind: target.kind, name: target.name, reason: rejected || `HTTP ${response.status}` };
    }
    return { ok: true, id: target.id, kind: target.kind, name: target.name };
  } catch (error) {
    return { ok: false, id: target.id, kind: target.kind, name: target.name, reason: error.message };
  }
}

export async function sendWebhooks(targets, text, opts = {}) {
  const list = Array.isArray(targets) ? targets : [];
  if (!list.length) return { ok: 0, failed: 0, results: [] };
  const results = await Promise.all(list.map(target => sendWebhook(target, text, opts)));
  return {
    ok: results.filter(item => item.ok).length,
    failed: results.filter(item => !item.ok).length,
    results,
  };
}
