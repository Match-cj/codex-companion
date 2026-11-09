// Turns raw errors into a sentence a non-programmer can act on.
//
// Every message here was written for a specific failure people actually hit
// (expired login, dead proxy, closed stream). Keep them concrete: naming the
// cause is the whole point, "操作失败" would tell them nothing.

// Codex 有时会把整段 JSON 错误（{"detail":...,"error":{"message":...}}）原样抛出来。
// 先把里面那句人话挖出来，再走下面的翻译规则。
function unwrapErrorMessage(message) {
  const text = String(message || '').trim();
  if (!text.startsWith('{') && !text.startsWith('操作没有完成：{')) return text;
  const bare = text.replace(/^操作没有完成：/, '');
  try {
    const parsed = JSON.parse(bare);
    const candidate = parsed?.error?.message || parsed?.detail || parsed?.message;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  } catch {}
  const match = bare.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    try { return JSON.parse(`"${match[1]}"`).trim(); } catch { return match[1].trim(); }
  }
  return text;
}

export function humanError(error) {
  const message = unwrapErrorMessage(error?.message || error) || '未知错误';
  if (/invalid refresh token|token refresh|refresh token|token.{0,30}(expired|revoked)|token_expired|token_revoked|unauthorized|401\b/i.test(message)) return '这个账号的登录已经失效，请在 Companion 网页中重新登录后再刷新。';
  if (message.startsWith('测试发送失败')) return message;
  if (message.includes('ECONNREFUSED')) return '连接不上本地服务，请确认 Codex Companion 正在运行。';
  // "fetch failed" 是 Node 访问远程网站失败的笼统报错（GitHub/OpenAI 等），和本地服务无关，不能混为一谈。
  if (message.includes('fetch failed')) return '网络连接失败：连不上目标网站（GitHub/OpenAI），通常是网络或系统代理暂时不可用。稍后会自动重试。';
  if (/failed to fetch codex rate limits|error sending request for url.*(?:chatgpt\.com|openai\.com)/i.test(message)) return '额度刷新失败：当前网络或系统代理无法连接 OpenAI 额度接口。页面显示的是上一次成功读取的缓存额度；请检查代理/网络后点击“立即刷新”，这不是额度已耗尽。';
  if (message.includes('ENOENT')) return '找不到需要启动的程序，请确认 Codex CLI 已正确安装。';
  if (message.includes('超时')) return 'Codex 两分钟没有回应。任务可能卡住了，请稍后重试或重启 Companion。';
  if (/stream disconnected|stream closed before response\.completed|connection reset|socket hang up/i.test(message)) return 'Codex 连接在回复完成前中断了。请确认本机代理/网络正常后，再回复“继续”；本次没有消耗新的任务内容。';
  if (message.includes('有任务正在运行')) return message;
  if (message.includes('Webhook')) return message;
  if (message.includes('HTTP 400')) return '账号或请求信息已经失效，请刷新账号；如果仍失败，请在 Companion 网页中重新登录。';
  if (message.includes('Country, region, or territory not supported') || message.includes('unsupported_country_region_territory')) return '登录网页已经通过，但后台没有走浏览器正在使用的代理线路。Companion 会改用系统代理重试；如果仍失败，请确认代理软件正在运行。';
  const unsupportedModel = message.match(/The '([^']+)' model is not supported/i) || (message.includes('model is not supported') ? [, ''] : null);
  if (unsupportedModel) {
    const model = unsupportedModel[1] ? `「${unsupportedModel[1]}」` : '';
    return `这个对话用的模型${model}不支持用 ChatGPT 账号跑，最常见的原因是会员刚好到期或降级了。在 Codex 底部换一个可用的模型，或换到合适的账号再继续。`;
  }
  if (/model_not_found|no such model|unknown model|模型.*(不存在|不可用|找不到)/i.test(message)) return '这个对话用的模型已经不存在或当前账号用不了。在 Codex 底部的模型下拉里换一个可用模型即可继续，不用点重试。';
  return `操作没有完成：${message}`;
}
