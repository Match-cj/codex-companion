// Update failures used to vanish: server.stdout.log / server.stderr.log are
// overwritten on every restart, and the widget hid the update dot as soon as
// a click was made. These pure helpers keep the last failure explicit, decide
// when a quiet retry is safe, and format an append-only log that survives a
// restart. No I/O here so the decisions can be tested without Windows.
export const UPDATE_LOG_MAX_BYTES = 256 * 1024;
export const UPDATE_RETRY_GAP_MS = 10 * 60 * 1000;
export const UPDATE_RETRY_LIMIT = 3;

const STAGE_LABELS = {
  check: '检查新版本',
  download: '下载更新包',
  verify: '校验更新包',
  extract: '解压更新包',
  replace: '替换程序文件',
  restart: '重启新版本',
  rollback: '新版本启动失败，已回滚',
  apply: '安装更新',
};

export function stageLabel(stage) {
  return STAGE_LABELS[stage] || '安装更新';
}

export function updateFailureRecord(error, { at = Date.now(), from = '', to = '', stage = 'apply', attempts = 0 } = {}) {
  const raw = String(error?.message || error || '未知原因').replace(/\s+/g, ' ').trim();
  return {
    at: Number(at) || Date.now(),
    from: String(from || ''),
    to: String(to || ''),
    stage: STAGE_LABELS[stage] ? stage : 'apply',
    attempts: Math.max(0, Number(attempts) || 0),
    message: raw.slice(0, 600),
  };
}

export function updateRetryDecision({
  lastError = null,
  now = Date.now(),
  canApply = false,
  applying = false,
  minGapMs = UPDATE_RETRY_GAP_MS,
  maxAttempts = UPDATE_RETRY_LIMIT,
} = {}) {
  if (applying) return { retry: false, reason: 'already-running' };
  if (!lastError) return { retry: false, reason: 'no-failure' };
  if (!canApply) return { retry: false, reason: 'needs-installer' };
  if (Number(lastError.attempts || 0) >= Number(maxAttempts)) return { retry: false, reason: 'too-many-tries' };
  if (Number(now) - Number(lastError.at || 0) < Number(minGapMs)) return { retry: false, reason: 'too-soon' };
  return { retry: true, reason: 'quiet-retry' };
}

export function describeUpdateFailure(record) {
  if (!record) return '';
  const when = new Date(Number(record.at) || Date.now()).toLocaleString('zh-CN', { hour12: false });
  const target = record.to ? `v${record.to}` : '新版本';
  return `上次更新到 ${target} 没成功（${stageLabel(record.stage)}）：${record.message}\n时间：${when}。软件会自动重试；也可以点这里马上再试。`;
}

export function updateLogLine(at, level, message) {
  const stamp = new Date(Number(at) || Date.now()).toISOString();
  const text = String(message || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return `${stamp} [${String(level || 'INFO').toUpperCase()}] ${text}\n`;
}

export function trimUpdateLog(text, maxBytes = UPDATE_LOG_MAX_BYTES) {
  const value = String(text || '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  // Keep the newest lines; a truncated first line is fine for a diagnostic log.
  const lines = value.split('\n');
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const bytes = Buffer.byteLength(`${lines[i]}\n`, 'utf8');
    if (size + bytes > maxBytes) break;
    size += bytes;
    kept.unshift(lines[i]);
  }
  return kept.join('\n') + (kept.length ? '\n' : '');
}
