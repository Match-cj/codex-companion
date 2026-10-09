import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const widget = fs.readFileSync(new URL('../Quota Widget WPF.ps1', import.meta.url), 'utf8');
const dashboard = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
test('widget and webpage use the same account-switch action after confirmation', () => {
  const action = widget.slice(widget.indexOf('function Switch-WidgetAccount('), widget.indexOf('function Warmup-WidgetAccount('));
  assert.match(action, /api\/codex\/status/);
  assert.match(action, /MessageBoxResult\]::Yes/);
  assert.match(action, /closeCodex=\$true/);
  assert.match(action, /api\/accounts\/switch/);
  assert.doesNotMatch(action, /validateOnly/);
  assert.match(action, /activeAccountId/);
  assert.match(dashboard, /function switchAccount\(id\).*closeCodex:true/);
});
test('inactive account cards switch only after a double click', () => {
  assert.match(widget, /Add_PreviewMouseLeftButtonDown/);
  assert.match(widget, /ClickCount-lt 2/);
  assert.doesNotMatch(widget, /DoubleClickTime|LastClick/);
  assert.match(widget, /Switch-WidgetAccount/);
  assert.doesNotMatch(widget, /\$switchButton\.Content='切换账号'/);
});
