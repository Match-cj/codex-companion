import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stallNoticeDecision, stallNoticeBody } from '../stall-notice.mjs';

const OLD_ANSWER = '0.7.286 完整安装包已经整理好，可以直接给同事安装：[下载 Match Tools 0.7.286 完整安装包](C:/Users/M0097/Desktop/Match%20Tools_0.7.286_x64-setup.exe)';
const now = 1_800_000_000_000;
const base = () => ({
  id: '01a18178-a01c-7923-b81f-f5d9994abb98',
  status: 'running',
  lastEventAt: now - 4 * 60000,
  stallNotified: false,
  output: OLD_ANSWER,   // whole-conversation history, must never be quoted
  turnOutput: '',       // this turn produced nothing
});

test('a stalled turn quotes nothing from the previous turn', () => {
  const decision = stallNoticeDecision(base(), { now, stallMinutes: 3 });
  assert.equal(decision.notify, true);
  assert.equal(decision.turnText, '');
  assert.doesNotMatch(decision.body, /0\.7\.286|完整安装包/);
  assert.match(decision.body, /本轮还没有新输出/);
  assert.match(decision.body, /会话正在别的窗口使用/);
  assert.match(stallNoticeBody(''), /恢复后会自动继续/);
});

test('only this turn output is quoted, and long output keeps the tail', () => {
  const task = { ...base(), turnOutput: '这一轮的新进展：字体检测已改好。' };
  const decision = stallNoticeDecision(task, { now, stallMinutes: 3 });
  assert.equal(decision.notify, true);
  assert.match(decision.body, /这一轮的新进展/);
  assert.doesNotMatch(decision.body, /0\.7\.286/);
  const long = stallNoticeBody('开'.repeat(50) + '尾部结论');
  assert.match(long, /尾部结论/);
  assert.ok(long.length < 1300);
});

test('re-continuing a stalled task cannot repost the same body', () => {
  const first = stallNoticeDecision(base(), { now, stallMinutes: 3 });
  const task = { ...base(), stallNotified: false, lastEventAt: now - 3 * 60000, stallNotifiedAt: now, stallFingerprint: first.fingerprint };
  const second = stallNoticeDecision(task, { now: now + 8 * 60000, stallMinutes: 3 });
  assert.equal(second.notify, false);
  assert.equal(second.duplicate, true);
  // A real new turn output changes the fingerprint, so a new stall is allowed.
  const progressed = { ...task, turnOutput: '本轮确实产出了新内容' };
  const third = stallNoticeDecision(progressed, { now: now + 8 * 60000, stallMinutes: 3 });
  assert.equal(third.notify, true);
  assert.notEqual(third.fingerprint, first.fingerprint);
});

test('quiet cases: not running, already notified, or not stalled long enough', () => {
  assert.equal(stallNoticeDecision({ ...base(), status: 'completed' }, { now }).notify, false);
  assert.equal(stallNoticeDecision({ ...base(), stallNotified: true }, { now }).notify, false);
  assert.equal(stallNoticeDecision({ ...base(), lastEventAt: now - 60000 }, { now }).notify, false);
  assert.equal(stallNoticeDecision({ ...base(), lastEventAt: 0 }, { now }).notify, false);
  assert.equal(stallNoticeDecision(base(), { now, stallMinutes: 10 }).notify, false);
});

test('the running server uses the decision helper and clears stale turn output', () => {
  const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(server.includes(`const APP_VERSION = '${pkg.version}'`), 'server version must match package.json');
  assert.match(server, /import \{ stallNoticeDecision \} from '\.\/stall-notice\.mjs'/);
  assert.match(server, /const decision = stallNoticeDecision\(t, \{ now: Date\.now\(\), stallMinutes: Number\(config\.stallMinutes\) \|\| 3 \}\)/);
  assert.match(server, /t\.stallFingerprint = decision\.fingerprint/);
  assert.match(server, /\$\{decision\.body\}/);
  assert.doesNotMatch(server, /trim\(t\.output, 1800\)/);
  assert.match(server, /turnOutput: '',\n      turnFinalText: '',/);
  assert.match(server, /task\.turnOutput = '';\n      task\.turnFinalText = '';/);
});
