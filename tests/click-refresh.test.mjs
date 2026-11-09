import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const server = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');

const start = server.indexOf('let manualQuotaRefresh =');
const end = server.indexOf('async function refreshAccounts(', start);
assert(start > 0 && end > start, 'click-refresh helper must be a standalone slice');
const slice = server.slice(start, end);

function loadHelper(refreshAccounts) {
  let now = 1000;
  const timers = [];
  const context = {
    refreshAccounts,
    humanError: error => `人话：${error.message}`,
    console: { error() {} },
    Date: { now: () => now },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
  };
  vm.runInNewContext(`${slice}\nglobalThis.startManualQuotaRefresh = startManualQuotaRefresh;\nglobalThis.getState = () => manualQuotaRefresh;`, context);
  return { context, timers, advance: ms => { now += ms; }, state: () => context.getState() };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('click refresh returns immediately, dedupes while running, and reports completion', async () => {
  let release;
  const helper = loadHelper(() => new Promise(resolve => { release = resolve; }));
  const first = helper.context.startManualQuotaRefresh();
  assert.equal(first.started, true);
  assert.equal(first.running, true);
  assert.equal(first.startedAt, 1000);
  // 同一次刷新没完成前再点，不应该重复启动（避免每次点都拉一遍账号）。
  const second = helper.context.startManualQuotaRefresh();
  assert.equal(second.started, false);
  assert.equal(second.running, true);
  helper.advance(2500);
  release();
  await tick();
  const done = helper.state();
  assert.equal(done.running, false);
  assert.equal(done.error, '');
  assert(done.finishedAt >= done.startedAt);
  assert.equal(helper.timers.length, 1);
  assert.equal(helper.timers[0].ms, 70000);
});

test('a failed click refresh always clears the spinner and speaks Chinese', async () => {
  const helper = loadHelper(() => Promise.reject(Error('fetch failed')));
  helper.context.startManualQuotaRefresh();
  await tick();
  const done = helper.state();
  assert.equal(done.running, false);
  assert.match(done.error, /人话/);
  assert(done.finishedAt > 0);
});

test('watchdog releases the spinner when native reading hangs', async () => {
  let release;
  const helper = loadHelper(() => new Promise(resolve => { release = resolve; }));
  helper.context.startManualQuotaRefresh();
  helper.advance(5000);
  assert.equal(helper.state().running, true);
  helper.timers[0].fn();
  assert.equal(helper.state().running, false);
  assert.match(helper.state().error, /刷新用时较长/);
  // 后台最终回来时不能把已经结束的状态改回去（finish 有 guard）。
  release();
  await tick();
  assert.equal(helper.state().running, false);
  assert.equal(helper.state().error, '刷新用时较长，已按现有数据继续。');
});

test('status exposes refresh progress, and quick refresh keeps the old blocking endpoint', () => {
  assert.match(server, /quotaRefresh:\{ running:manualQuotaRefresh\.running/);
  assert.match(server, /if \(data\.quick === true\) return send\(res,200,\{ok:true,\.\.\.startManualQuotaRefresh\(\)\}\)/);
  assert.match(server, /await refreshAccounts\(\{forceNative:true,awaitNative:true\}\);return send\(res,200,\{ok:true,accounts\}\)/);
});

test('every click entry point in the widget really asks the backend for fresh quota', () => {
  assert.match(widget, /Body '\{"quick":true\}'/);
  assert.match(widget, /\{Show-Detail;Request-QuotaRefresh\}/);
  assert.match(widget, /\$Refresh\.Add_Click\(\{Request-QuotaRefresh\}\)/);
  assert.match(widget, /\$sender\.Text='↻ 刷新中…';Request-QuotaRefresh/);
  assert.match(widget, /Add_Tick\(\{Poll-QuotaRefresh\}\)/);
  assert.match(widget, /quotaRefresh\.finishedAt-ge\$script:QuotaRefreshStartedAt/);
  assert.match(widget, /function Refresh-Detail/);
  assert.doesNotMatch(widget, /\$Refresh\.Add_Click\(\{Update-Widget\}\)/);
  assert.match(dashboard, /body:'\{"quick":true\}'/);
  assert.match(dashboard, /st\.quotaRefresh&&!st\.quotaRefresh\.running/);
});
