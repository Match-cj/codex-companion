// Generic outbound notification layer.
//
// Feishu keeps its own rich implementation (app bot + topic threads + replies),
// because it is the only two-way channel. Everything else is one-way: we take a
// webhook URL, wrap the text in the shape that channel expects, and POST it.
//
// Adding a channel means adding one entry to KINDS and (optionally) one case in
// buildWebhookRequest. No server.mjs surgery required.

export const KINDS = [
  {
    id: 'wecom-app', label: '企业微信应用消息（一个人也能用）', recommend: true,
    hint: '地址里填 corpid / agentid / userid，密钥框填应用的 Secret',
    howto: '① 电脑打开 work.weixin.qq.com，用手机企业微信扫码登录（企业名称随便填、行业选“其他”、人数选 1-50，不需要营业执照）。'
      + '②「我的企业 → 企业信息」最下面复制 <b>CorpID</b>。'
      + '③「应用管理 → 自建 → 创建应用」，随便传个图标、起个名字，创建后点进去复制 <b>AgentId</b> 和 <b>Secret</b>。'
      + '④「通讯录」点你自己的名字，“账号”那一栏就是 <b>userid</b>（一般是手机号或拼音）。'
      + '⑤ 回到这里：地址填 <code>https://qyapi.weixin.qq.com/cgi-bin/message/send?corpid=你的CorpID&amp;agentid=你的AgentId&amp;touser=你的userid</code>，Secret 填在“密钥”框里。'
      + '⑥ 想用个人微信收：企业微信手机端「消息 → 微信插件」按提示开启，应用消息会转到微信。',
    limit: '免费；<b>不需要建群，一个人也能发给自己</b>。缺点：要建一次自建应用（约 10 分钟），Secret 只存在本机，不上传。',
    needsToken: true, maxBytes: 1800,
  },
  {
    id: 'wecom', label: '企业微信群机器人',
    hint: '群设置 → 群机器人 → 添加 → 复制 Webhook 地址',
    howto: '装一个企业微信 App（个人也能注册，企业名称随便填，不需要营业执照）→ 新建一个内部群 → 群设置 → 群机器人 → 添加 → 复制地址。用个人微信收：注册后在「微信插件」扫码绑定。',
    limit: '免费；每分钟 20 条。<b>前提是你得有一个内部群：企业微信内部群至少 3 人，只有自己一个人建不了群。</b>只有自己用请选上面的“应用消息”，或直接用飞书 / Server酱。',
    needsToken: false, maxBytes: 1800,
  },
  {
    id: 'dingtalk', label: '钉钉群机器人',
    hint: '群设置 → 智能群助手 → 添加机器人 → 自定义 → 复制 Webhook 地址',
    howto: '装钉钉（个人可注册）→ 建群 → 群设置 → 智能群助手 → 添加机器人 → 自定义 → 复制地址。',
    limit: '免费；每分钟 20 条。缺点是要装钉钉，且消息只在钉钉里。',
    needsToken: false, maxBytes: 1800,
  },
  {
    id: 'pushplus', label: 'PushPlus（微信）',
    hint: 'https://www.pushplus.plus 登录后复制 token，免费 200 条/天',
    howto: '打开 pushplus.plus 用微信扫码登录 → 复制首页的 token。',
    limit: '免费 200 条/天，消息直接进微信服务号。缺点：注册后要做「真人认证」（一次性小额付费）才能正常推送，否则容易被限制。',
    needsToken: true, maxBytes: 4000,
  },
  {
    id: 'serverchan', label: 'Server酱（微信）',
    hint: 'https://sct.ftqq.com 登录后复制 SendKey，免费 5 条/天',
    howto: '打开 sct.ftqq.com 用微信扫码登录 → 复制 SendKey。',
    limit: '免费版每天只有 5 条，一天几个任务就超了，只适合极低频或试用。',
    needsToken: true, maxBytes: 4000,
  },
  {
    id: 'bark', label: 'Bark（iPhone）',
    hint: 'Bark App 首页的推送地址，形如 https://api.day.app/你的key',
    howto: 'App Store 装 Bark → 打开 App，首页就是你的推送地址。',
    limit: '免费、无条数限制；只有 iPhone。国内走 APNs，偶尔会慢几秒。',
    needsToken: false, maxBytes: 3000,
  },
  {
    id: 'telegram', label: 'Telegram',
    hint: '地址填 https://api.telegram.org/bot<token>/sendMessage，token 填 chat_id',
    howto: '找 @BotFather 建机器人拿到 token；再给 @userinfobot 发消息拿到你的 chat_id。',
    limit: '免费、无限制；但国内需要能正常访问 Telegram。',
    needsToken: true, maxBytes: 4000,
  },
  {
    id: 'discord', label: 'Discord',
    hint: '频道设置 → 整合 → Webhook → 复制 Webhook URL',
    howto: '在 Discord 建一个服务器和频道 → 频道设置 → 整合 → Webhook → 新建 → 复制地址。',
    limit: '免费、无限制；但国内需要能正常访问 Discord。',
    needsToken: false, maxBytes: 1800,
  },
  {
    id: 'custom', label: '自定义（POST JSON）',
    hint: '向你的地址 POST {"text":"...","title":"..."}',
    howto: '填你自己的接口地址，我们会 POST 一个 JSON：{"title":"...","text":"...","app":"Codex Companion","at":"ISO 时间"}。',
    limit: '完全自由，可以接自己的脚本、Home Assistant、内网服务。缺点是要自己写接收端。',
    needsToken: false, maxBytes: 20000,
  },
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
    case 'wecom-app': {
      // The CorpID / AgentId / userid travel in the address the user pasted;
      // the app Secret stays in the token field and is only used to fetch a
      // short-lived access token (never sent anywhere else).
      const params = new URL(url).searchParams;
      return {
        url: '',
        headers,
        body: {
          touser: String(params.get('touser') || ''),
          msgtype: 'text',
          agentid: Number(params.get('agentid') || 0),
          text: { content: body },
        },
        wecomApp: { corpid: String(params.get('corpid') || '') },
      };
    }
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

// WeCom app messages need a 2-hour access token; keep one per app so a burst of
// notifications does not re-authenticate every time.
const WECOM_TOKEN_ENDPOINT = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';
const WECOM_SEND_ENDPOINT = 'https://qyapi.weixin.qq.com/cgi-bin/message/send';
const WECOM_ERRORS = {
  40001: 'Secret 不对，或者这个应用不属于这个企业',
  40013: 'CorpID 不对',
  40014: 'access_token 无效',
  41001: '缺少 access_token（一般是 Secret 填错了）',
  45009: '企业微信接口调用太频繁，稍后再试',
  48002: '这个应用没有权限，或 userid 不在应用可见范围里',
  60020: 'IP 不在企业微信白名单里，请到应用设置里清空或加上本机 IP',
};
const wecomAppTokens = new Map();
// Tests need a clean slate between cases.
export function resetWecomAppTokens() { wecomAppTokens.clear(); }

function wecomAppError(payload, fallback) {
  const code = Number(payload?.errcode ?? payload?.code);
  const detail = String(payload?.errmsg || payload?.message || '').trim();
  if (Number.isFinite(code) && WECOM_ERRORS[code]) return `企业微信：${WECOM_ERRORS[code]}`;
  return detail ? `企业微信：${detail}` : fallback;
}
async function wecomAppAccessToken(corpid, secret, signal) {
  if (!corpid || !secret) throw Error('企业微信应用消息缺少 CorpID 或 Secret。');
  const key = `${corpid}|${secret}`;
  const cached = wecomAppTokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 60 * 1000) return cached.token;
  const url = `${WECOM_TOKEN_ENDPOINT}?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(secret)}`;
  const response = await fetch(url, { signal });
  const payload = await response.json().catch(() => null);
  const token = String(payload?.access_token || '');
  if (!token) throw Error(wecomAppError(payload, '企业微信没有返回调用凭据。'));
  wecomAppTokens.set(key, { token, expiresAt: Date.now() + Number(payload?.expires_in || 7200) * 1000 });
  return token;
}
async function postJson(url, request, opts = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: opts.signal,
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

export async function sendWebhook(target, text, opts = {}) {
  let request;
  try {
    request = buildWebhookRequest(target, text, opts);
  } catch (error) {
    return { ok: false, id: target.id, kind: target.kind, name: target.name, reason: error.message };
  }
  if (!request.url && !request.wecomApp) {
    return { ok: false, id: target.id, kind: target.kind, name: target.name, reason: '缺少推送地址' };
  }
  try {
    let delivery;
    if (request.wecomApp) {
      const accessToken = await wecomAppAccessToken(request.wecomApp.corpid, String(target.token || '').trim(), opts.signal);
      delivery = await postJson(`${WECOM_SEND_ENDPOINT}?access_token=${encodeURIComponent(accessToken)}`, request, opts);
    } else {
      delivery = await postJson(request.url, request, opts);
    }
    const { response, payload } = delivery;
    const rejected = webhookBodyRejected(target.kind, payload);
    if (!response.ok || rejected) {
      const reason = target.kind === 'wecom-app' && payload ? wecomAppError(payload, rejected) : rejected || `HTTP ${response.status}`;
      return { ok: false, id: target.id, kind: target.kind, name: target.name, reason };
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
