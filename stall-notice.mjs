// A "no progress" reminder must describe THIS turn only.
//
// `task.output` is the whole conversation history since the thread was resumed,
// so quoting it in a stall notice reposts an already-delivered final answer.
// That is what made one finished result appear again and again after the
// conversation was resumed. Stall notices now quote `turnOutput` (reset on each
// new turn), say one short line when there is no new output, and never repeat
// the same body for the same task.
import { createHash } from 'node:crypto';

const NO_OUTPUT_HINT = '本轮还没有新输出。常见原因：Codex 会话正在别的窗口使用、账号登录失效、模型繁忙或网络不通；恢复后会自动继续，不用手动操作。';

export function stallNoticeBody(turnText = '') {
  const text = String(turnText || '').trim();
  if (!text) return NO_OUTPUT_HINT;
  const tail = text.length > 1200 ? `…${text.slice(-1200)}` : text;
  return `本轮已经输出：\n${tail}`;
}

export function stallNoticeDecision(task = {}, { now = Date.now(), stallMinutes = 3 } = {}) {
  if (task.status !== 'running' || task.stallNotified) return { notify: false };
  const lastEventAt = Number(task.lastEventAt || 0);
  const threshold = (Number(stallMinutes) || 3) * 60000;
  if (!lastEventAt || now - lastEventAt <= threshold) return { notify: false };

  const turnText = String(task.turnOutput || task.turnFinalText || '').trim();
  const fingerprint = createHash('sha1').update(turnText || '(no output)').digest('hex').slice(0, 12);
  // Re-continuing a stalled task resets stallNotified, but the same body must
  // never be delivered twice. A genuinely new turn output changes the hash.
  if (task.stallFingerprint === fingerprint && Number(task.stallNotifiedAt || 0) > 0) {
    return { notify: false, duplicate: true };
  }
  return { notify: true, fingerprint, body: stallNoticeBody(turnText), turnText };
}
